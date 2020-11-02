import {
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  domains,
  domainsCreateInput,
  domainsOrderByInput,
  domainsWhereInput,
  domainsWhereUniqueInput,
} from '@prisma/client';
import got from 'got';
import { BadRequestError } from 'passport-headerapikey';
import { DnsService } from '../dns/dns.service';
import { Expose } from '../prisma/prisma.interface';
import { PrismaService } from '../prisma/prisma.service';
import { TokensService } from '../tokens/tokens.service';
import {
  DOMAIN_VERIFICATION_HTML,
  DOMAIN_VERIFICATION_TXT,
} from './domains.constants';
import { DomainVerificationMethods } from './domains.interface';

@Injectable()
export class DomainsService {
  constructor(
    private prisma: PrismaService,
    private tokensService: TokensService,
    private dnsService: DnsService,
    private configService: ConfigService,
  ) {}

  async createDomain(
    groupId: number,
    data: Omit<Omit<domainsCreateInput, 'group'>, 'verificationCode'>,
  ): Promise<domains> {
    const verificationCode = this.tokensService.generateUuid();
    return this.prisma.domains.create({
      data: {
        ...data,
        verificationCode,
        group: { connect: { id: groupId } },
      },
    });
  }

  async getDomains(
    groupId: number,
    params: {
      skip?: number;
      take?: number;
      cursor?: domainsWhereUniqueInput;
      where?: domainsWhereInput;
      orderBy?: domainsOrderByInput;
    },
  ): Promise<Expose<domains>[]> {
    const { skip, take, cursor, where, orderBy } = params;
    const domains = await this.prisma.domains.findMany({
      skip,
      take,
      cursor,
      where: { ...where, group: { id: groupId } },
      orderBy,
    });
    return domains.map((group) => this.prisma.expose<domains>(group));
  }

  async getDomain(groupId: number, id: number): Promise<Expose<domains>> {
    const domain = await this.prisma.domains.findOne({
      where: { id },
    });
    if (!domain)
      throw new HttpException('Domain not found', HttpStatus.NOT_FOUND);
    if (domain.groupId !== groupId) throw new UnauthorizedException();
    return this.prisma.expose<domains>(domain);
  }

  async verifyDomain(
    groupId: number,
    id: number,
    method: DomainVerificationMethods,
  ): Promise<Expose<domains>> {
    const domain = await this.prisma.domains.findOne({
      where: { id },
    });
    if (!domain)
      throw new HttpException('Domain not found', HttpStatus.NOT_FOUND);
    if (domain.groupId !== groupId) throw new UnauthorizedException();
    if (method === DOMAIN_VERIFICATION_TXT) {
      const txtRecords = await this.dnsService.lookup(domain.domain, 'TXT');
      if (JSON.stringify(txtRecords).includes(domain.verificationCode)) {
        await this.prisma.domains.update({
          where: { id },
          data: { isVerified: true },
        });
      } else throw new BadRequestError('TXT record not found');
    } else if (method === DOMAIN_VERIFICATION_HTML) {
      let verified = false;
      try {
        const { body } = await got(
          `http://${domain.domain}/.well-known/${this.configService.get<string>(
            'meta.domainVerificationFile' ?? 'staart-verify.txt',
          )}`,
        );
        verified = body.includes(domain.verificationCode);
      } catch (error) {}
      if (verified) {
        await this.prisma.domains.update({
          where: { id },
          data: { isVerified: true },
        });
      } else throw new BadRequestError('HTML file not found');
    } else throw new BadRequestError('Type should be TXT or HTML');
    return domain;
  }

  async deleteDomain(groupId: number, id: number): Promise<Expose<domains>> {
    const testDomain = await this.prisma.domains.findOne({
      where: { id },
    });
    if (!testDomain)
      throw new HttpException('Domain not found', HttpStatus.NOT_FOUND);
    if (testDomain.groupId !== groupId) throw new UnauthorizedException();
    const domain = await this.prisma.domains.delete({
      where: { id },
    });
    return this.prisma.expose<domains>(domain);
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { outboundProblem } from '../../common/http/outbound.js';
import { loadEnv } from '../../config/env.js';
import type { InstanceRow } from './connectors.repository.js';
import { SECRETS_PROVIDER, type SecretsProvider } from './secrets.js';
import { HttpSnowClient, SnowError, type SnowClient } from './snow-client.js';

/** Builds a client for an instance from its secret reference; the secret never leaves this call. */
@Injectable()
export class SnowClientFactory {
  constructor(@Inject(SECRETS_PROVIDER) private readonly secrets: SecretsProvider) {}

  async forInstance(
    instance: Pick<InstanceRow, 'base_url' | 'auth_kind' | 'credential_secret_name'>,
  ): Promise<SnowClient> {
    const problem = await outboundProblem(instance.base_url, loadEnv().WEBHOOK_ALLOW_PRIVATE === 'true');
    if (problem) throw new SnowError(0, `destination refused (${problem})`);
    const secret = await this.secrets.get(instance.credential_secret_name);
    if (!secret) throw new SnowError(401, `credential ${instance.credential_secret_name} is not available`);
    return new HttpSnowClient(instance.base_url, {
      kind: instance.auth_kind,
      username: secret.username,
      password: secret.password,
      clientId: secret.client_id,
      clientSecret: secret.client_secret,
    });
  }
}

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { SYSTEM_ACTOR, AuditService } from '../common/audit/audit.service.js';
import { loadEnv } from '../config/env.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { BootstrapService } from '../modules/admin/bootstrap.service.js';
import { ConfigService } from '../modules/admin/config/config.service.js';
import { AccountsRepository } from '../modules/admin/accounts/accounts.repository.js';
import { UsersRepository } from '../modules/admin/users/users.repository.js';

/**
 * Development seed (P1.3.7, Test Strategy section 4, first slice): the
 * system roles, the configuration defaults, an administrator for every
 * BOOTSTRAP_ADMIN_EMAILS entry bound to the dev-token subject, two accounts
 * with contrasting time zones, and three assignment groups. Idempotent.
 *
 *   pnpm seed:dev
 *   pnpm dev:token --email admin@example.test
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const uow = app.get(UnitOfWork);
  const users = app.get(UsersRepository);
  const accounts = app.get(AccountsRepository);
  const audit = app.get(AuditService);
  const bootstrap = app.get(BootstrapService);
  const config = app.get(ConfigService);

  const createdConfig = await config.ensureDefaults();
  console.log(`configuration defaults: ${createdConfig.length} created`);

  await uow.operator(async (tx) => {
    const roles = await bootstrap.ensureSystemRoles(tx);
    console.log(`system roles: ${roles.length} created`);
    const administrator = (await users.roleByName(tx, 'operator', 'Administrator'))!;
    for (const email of env.BOOTSTRAP_ADMIN_EMAILS) {
      const existing = await users.byEmail(tx, email);
      const user =
        existing ??
        (await users.insert(tx, {
          kind: 'internal',
          email,
          clerk_user_id: `dev_${email.replace(/[^a-z0-9]/gi, '_')}`,
          status: 'active',
          first_name: 'Dev',
          last_name: 'Administrator',
        }));
      const assigned = await users.assignmentsOf(tx, user.id);
      if (!assigned.some((role) => role.role_id === administrator.id)) {
        await users.replaceAssignments(tx, user.id, [
          ...assigned.map((role) => ({ roleId: role.role_id, accountId: role.account_id })),
          { roleId: administrator.id, accountId: null },
        ]);
      }
      console.log(`administrator ${email} ready (${existing ? 'existing' : 'created'})`);
    }
    for (const name of ['CSM', 'OneStream Technical', 'Infrastructure']) {
      const exists = (await users.groups(tx)).some((group) => group.name === name);
      if (!exists) await users.insertGroup(tx, { name });
    }
  });

  const seedAccounts = [
    { key: 'BRK', name: 'Brookfield', default_time_zone: 'America/Toronto' },
    { key: 'AUS', name: 'Austral Mining', default_time_zone: 'Australia/Sydney' },
  ];
  for (const seed of seedAccounts) {
    const existing = await uow.operator((tx) => accounts.list(tx, { limit: 200 }));
    if (existing.some((account) => account.key === seed.key)) continue;
    const account = await uow.operator((tx) => accounts.insert(tx, { ...seed }));
    await uow.worker([account.id], async (tx) => {
      await accounts.insertSettings(tx, account.id);
      await audit.account(tx, account.id, SYSTEM_ACTOR, {}, [
        {
          entityKind: 'account',
          entityId: account.id,
          eventType: 'admin.account.created',
          newValue: { key: account.key, seed: true },
        },
      ]);
      await tx.query(`update op.accounts set status = 'active' where id = $1`, [account.id]);
    });
    console.log(`account ${seed.key} created`);
  }

  await app.close();
}

await main();

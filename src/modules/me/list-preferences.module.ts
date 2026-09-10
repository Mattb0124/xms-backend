import { Body, Controller, Delete, Get, HttpCode, Injectable, Module, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { CurrentPrincipal, RequirePermission } from '../../common/auth/decorators.js';
import type { Principal } from '../../common/auth/principal.js';
import { RepositoryBase, type Tx } from '../../db/repository.base.js';
import { UnitOfWork } from '../../db/unit-of-work.js';

/**
 * What a reader wants a list to look like: which columns it draws, in what
 * order, and the display switches beside them.
 *
 * It is a preference, not data. Nothing here is authoritative about the
 * product: the screen owns the columns that exist and their defaults, and
 * this only says which of them one person wants and in what order. A row that
 * names a column the product no longer has costs nothing, because the screen
 * ignores what it does not recognise.
 *
 * Operator scope, keyed on the person, so an arrangement holds across
 * accounts and machines.
 */
export interface ListPreferenceRow {
  user_id: string;
  screen: string;
  columns: string[];
  options: Record<string, unknown>;
  updated_at: string;
}

export class SaveListPreferenceDto {
  /** The column keys to draw, in the order to draw them. */
  @IsArray()
  @ArrayMaxSize(60)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  columns!: string[];

  /** The dialogue's own switches: wrap, compact, highlight, and the rest. */
  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;
}

export class ScreenParam {
  /** A screen key, as the route registry names it. */
  @Matches(/^[a-z][a-z0-9._-]{0,63}$/)
  screen!: string;
}

@Injectable()
export class ListPreferencesRepository extends RepositoryBase {
  byScreen(tx: Tx, userId: string, screen: string): Promise<ListPreferenceRow | undefined> {
    return this.maybeOne<ListPreferenceRow>(
      tx,
      'select * from op.list_preferences where user_id = $1 and screen = $2',
      [userId, screen],
    );
  }

  all(tx: Tx, userId: string): Promise<ListPreferenceRow[]> {
    return this.many<ListPreferenceRow>(tx, 'select * from op.list_preferences where user_id = $1 order by screen', [
      userId,
    ]);
  }

  save(
    tx: Tx,
    userId: string,
    screen: string,
    columns: string[],
    options: Record<string, unknown>,
  ): Promise<ListPreferenceRow> {
    return this.one<ListPreferenceRow>(
      tx,
      'list preference',
      `insert into op.list_preferences (user_id, screen, columns, options)
            values ($1, $2, $3::jsonb, $4::jsonb)
       on conflict (user_id, screen)
         do update set columns = excluded.columns, options = excluded.options, updated_at = now()
         returning *`,
      [userId, screen, JSON.stringify(columns), JSON.stringify(options)],
    );
  }

  clear(tx: Tx, userId: string, screen: string): Promise<void> {
    return tx
      .query('delete from op.list_preferences where user_id = $1 and screen = $2', [userId, screen])
      .then(() => undefined);
  }
}

@Injectable()
export class ListPreferencesService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly preferences: ListPreferencesRepository,
  ) {}

  /** Every arrangement this reader has, so the shell can hold them all at once. */
  all(principal: Principal): Promise<ListPreferenceRow[]> {
    return this.uow.operator((tx) => this.preferences.all(tx, principal.userId));
  }

  save(principal: Principal, screen: string, dto: SaveListPreferenceDto): Promise<ListPreferenceRow> {
    // Duplicates are dropped rather than refused: a reader moving a column
    // twice means it once, and a refusal here would be a dialogue that
    // cannot be closed.
    const columns = [...new Set(dto.columns.map((column) => column.trim()).filter(Boolean))];
    return this.uow.operator((tx) => this.preferences.save(tx, principal.userId, screen, columns, dto.options ?? {}));
  }

  /** Back to the screen's own default: the row goes, rather than being emptied. */
  clear(principal: Principal, screen: string): Promise<void> {
    return this.uow.operator((tx) => this.preferences.clear(tx, principal.userId, screen));
  }
}

@ApiTags('me')
@ApiBearerAuth()
@Controller('me/list-preferences')
export class ListPreferencesController {
  constructor(private readonly preferences: ListPreferencesService) {}

  @Get()
  @RequirePermission('tickets:view')
  all(@CurrentPrincipal() principal: Principal) {
    return this.preferences.all(principal);
  }

  @Put(':screen')
  @RequirePermission('tickets:view')
  save(@CurrentPrincipal() principal: Principal, @Param() params: ScreenParam, @Body() dto: SaveListPreferenceDto) {
    return this.preferences.save(principal, params.screen, dto);
  }

  @Delete(':screen')
  @HttpCode(204)
  @RequirePermission('tickets:view')
  clear(@CurrentPrincipal() principal: Principal, @Param() params: ScreenParam) {
    return this.preferences.clear(principal, params.screen);
  }
}

@Module({
  providers: [ListPreferencesRepository, ListPreferencesService],
  controllers: [ListPreferencesController],
  exports: [ListPreferencesService],
})
export class ListPreferencesModule {}

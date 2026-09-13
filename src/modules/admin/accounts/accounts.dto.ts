import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  IsUUID,
} from 'class-validator';
import { MaxJsonSize } from '../../../common/validation/max-json-size.js';

export class CreateAccountDto {
  @IsString()
  @Matches(/^[A-Z0-9]{2,8}$/, { message: 'key must be 2 to 8 upper-case letters or digits' })
  key!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  legal_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  residency_region?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  default_time_zone?: string;

  @IsOptional()
  @IsIn(['shared', 'dedicated'])
  isolation_tier?: 'shared' | 'dedicated';
}

export class UpdateAccountDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  legal_name?: string | null;

  @IsOptional()
  @IsIn(['shared', 'dedicated'])
  isolation_tier?: 'shared' | 'dedicated';

  @IsOptional()
  @IsString()
  @MaxLength(40)
  residency_region?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  default_time_zone?: string;

  @IsOptional()
  @IsObject()
  @MaxJsonSize()
  branding?: Record<string, unknown>;
}

/**
 * Handing the account to somebody else (TM-23). Its own route and its own
 * DTO, because the change is a change of who answers for the client and it
 * has to be visible as that in the audit stream, not as one field of a
 * general edit.
 */
export class ChangeAccountOwnerDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsUUID('4')
  owner_user_id!: string;

  /** Why the account moved. Read by whoever asks the question later. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class UpdateAccountSettingsDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsBoolean()
  portal_enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  consumption_visible?: boolean;

  @IsOptional()
  @IsBoolean()
  csat_enabled?: boolean;

  @IsOptional()
  @IsIn(['off', 'ingest_only', 'bidirectional'])
  sync_mode?: 'off' | 'ingest_only' | 'bidirectional';

  @IsOptional()
  @IsBoolean()
  ai_enabled?: boolean;

  @IsOptional()
  @IsObject()
  @MaxJsonSize()
  ai_opt_ins?: Record<string, string>;

  @IsOptional()
  @IsObject()
  @MaxJsonSize()
  email_branding?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  outbound_identity?: string | null;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  inbound_aliases?: string[];

  @IsOptional()
  @IsInt()
  @Min(30)
  retention_days?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1024)
  attachment_max_bytes?: number;

  @IsOptional()
  @IsBoolean()
  usage_analytics_portal?: boolean;

  @IsOptional()
  @IsBoolean()
  store_search_terms?: boolean;

  /**
   * Container-case thresholds (TM-27). Null switches one off, which is what
   * an account that has not thought about it should have; zero is refused
   * because it would mean "flag everything".
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  container_time_entries?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  container_elapsed_days?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  container_effort_minutes?: number | null;
}

export class ListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsString()
  status?: string;
}

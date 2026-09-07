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
} from 'class-validator';

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
  branding?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  owner_user_id?: string | null;
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
  ai_opt_ins?: Record<string, string>;

  @IsOptional()
  @IsObject()
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

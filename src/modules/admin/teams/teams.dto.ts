import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min, MinLength } from 'class-validator';

/**
 * A team groups people and the accounts they are responsible for (TM-23).
 * The membership routes take the whole set rather than one id at a time, so
 * a reorganisation is one audited change and not a burst of them.
 */
export class CreateTeamDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsUUID('4')
  lead_user_id?: string | null;
}

export class UpdateTeamDto {
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
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsUUID('4')
  lead_user_id?: string | null;

  @IsOptional()
  @IsIn(['active', 'retired'])
  status?: 'active' | 'retired';
}

/** The whole membership, replacing what is there. */
export class SetTeamMembersDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  user_ids!: string[];
}

/** The whole book of business, replacing what is there. */
export class SetTeamAccountsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  account_ids!: string[];
}

export class TeamsQueryDto {
  @IsOptional()
  @IsIn(['active', 'retired'])
  status?: 'active' | 'retired';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

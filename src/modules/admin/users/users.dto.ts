import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class InviteUserDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  first_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  last_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  time_zone?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  role_ids?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  account_ids?: string[];
}

export class UpdateUserDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  first_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  last_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  business_phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  mobile_phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  time_zone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  date_format?: string;

  @IsOptional()
  @IsIn(['active', 'deactivated'])
  status?: 'active' | 'deactivated';
}

export class RoleAssignmentDto {
  @IsUUID('4')
  role_id!: string;

  @IsOptional()
  @IsUUID('4')
  account_id?: string | null;
}

export class ReplaceRolesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoleAssignmentDto)
  roles!: RoleAssignmentDto[];
}

export class ReplaceGrantsDto {
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  account_ids!: string[];
}

export class ReplaceGranteesDto {
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  user_ids!: string[];
}

export class ReplaceMembersDto {
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  user_ids!: string[];
}

export class CreateRoleDto {
  @IsIn(['operator', 'portal'])
  catalog!: 'operator' | 'portal';

  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsArray()
  @IsString({ each: true })
  permissions!: string[];
}

export class UpdateRoleDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];

  @IsOptional()
  @IsIn(['active', 'retired'])
  status?: 'active' | 'retired';
}

export class CreateGroupDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  service_line?: string | null;

  @IsOptional()
  @IsUUID('4')
  lead_user_id?: string | null;
}

export class UpdateGroupDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  service_line?: string | null;

  @IsOptional()
  @IsUUID('4')
  lead_user_id?: string | null;

  @IsOptional()
  @IsIn(['active', 'retired'])
  status?: 'active' | 'retired';
}

export class UsersQueryDto {
  @IsOptional()
  @IsIn(['internal', 'portal', 'service'])
  kind?: 'internal' | 'portal' | 'service';

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  assignable?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;
}

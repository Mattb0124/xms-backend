import { ArrayMaxSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import type { EventCondition } from './audit-search.js';

/**
 * The saved-query surface. The conditions themselves are not validated
 * here: `translateEvents` is the one judge of a condition, and the service
 * calls it before every save, so the shape check stops at "a list of at
 * most twenty" and the grammar answers the rest with its own typed 400.
 */
export class CreateSavedQueryDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @IsOptional()
  @IsBoolean()
  shared?: boolean;

  @IsArray()
  @ArrayMaxSize(20)
  conditions!: EventCondition[];
}

export class UpdateSavedQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @IsOptional()
  @IsBoolean()
  shared?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  conditions?: EventCondition[];
}

export class RunSavedQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  cursor?: string;
}

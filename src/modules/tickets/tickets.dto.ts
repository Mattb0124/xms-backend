import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MaxJsonSize } from '../../common/validation/max-json-size.js';
import { OUT_OF_SCOPE } from './conditions.js';

const TYPES = ['incident', 'service_request', 'change', 'problem', 'project_task'] as const;
const LEVELS = ['high', 'medium', 'low'] as const;
const PRIORITIES = ['p1', 'p2', 'p3', 'p4'] as const;

export class CreateTicketDto {
  @IsUUID('4')
  account_id!: string;

  @IsIn(TYPES)
  type!: (typeof TYPES)[number];

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  short_description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string;

  @IsOptional()
  @IsIn(LEVELS)
  impact?: (typeof LEVELS)[number];

  @IsOptional()
  @IsIn(LEVELS)
  urgency?: (typeof LEVELS)[number];

  @IsOptional()
  @IsUUID('4')
  group_id?: string;

  @IsOptional()
  @IsUUID('4')
  assignee_id?: string;

  @IsOptional()
  @IsUUID('4')
  contract_id?: string;

  /** The project or change window this ticket belongs to (TM-10). */
  @IsOptional()
  @IsUUID('4')
  ticket_group_id?: string;

  @IsOptional()
  @IsEmail()
  requester_email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  requester_name?: string;

  @IsOptional()
  @IsIn(['internal', 'api'])
  source?: 'internal' | 'api';
}

export class PatchTicketDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  short_description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50000)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  category?: string | null;

  @IsOptional()
  @IsIn(LEVELS)
  impact?: (typeof LEVELS)[number] | null;

  @IsOptional()
  @IsIn(LEVELS)
  urgency?: (typeof LEVELS)[number] | null;

  /** Direct priority; requires tickets:override-priority and is audited with the matrix value it replaced. */
  @IsOptional()
  @IsIn(PRIORITIES)
  priority?: (typeof PRIORITIES)[number];

  @IsOptional()
  @IsUUID('4')
  group_id?: string | null;

  @IsOptional()
  @IsUUID('4')
  assignee_id?: string | null;

  @IsOptional()
  @IsUUID('4')
  contract_id?: string;

  /** The project or change window this ticket belongs to (TM-10); null leaves it. */
  @IsOptional()
  @IsUUID('4')
  ticket_group_id?: string | null;

  @IsOptional()
  @IsObject()
  @MaxJsonSize(8 * 1024)
  external_refs?: Record<string, string>;
}

export class ResolutionDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  notes?: string;

  @IsOptional()
  @IsUUID('4')
  solution_article_id?: string;

  @IsOptional()
  @IsBoolean()
  solution_candidate?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  time_exemption_reason?: string;
}

export class TransitionDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsString()
  @Matches(/^[a-z][a-z0-9_]*$/)
  to!: string;

  @IsOptional()
  @IsIn(['awaiting_client', 'awaiting_third_party', 'scheduled_window', 'blocked'])
  pause_reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  /**
   * The reason that carries a change past its window rules (TM-18): it
   * acknowledges a freeze or a clash on the same configuration item when
   * scheduling, and it is the override reason when implementing outside the
   * window, which additionally needs tickets:override-change-window. Either
   * way it lands on the audit, because a window nobody can cross is not a
   * window and a crossing nobody recorded is not a decision.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  change_window_reason?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ResolutionDto)
  resolution?: ResolutionDto;
}

export class MessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50000)
  body!: string;
}

export class LinkDto {
  @IsUUID('4')
  to_ticket_id!: string;

  @IsIn(['parent', 'related', 'duplicate', 'blocks'])
  type!: 'parent' | 'related' | 'duplicate' | 'blocks';
}

export class WatchDto {
  @IsBoolean()
  muted!: boolean;
}

const toList = ({ value }: { value: unknown }): string[] | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? value.map(String) : String(value).split(',').filter(Boolean);

export class ListTicketsQueryDto {
  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsUUID('4', { each: true })
  account_id?: string[];

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsString({ each: true })
  state?: string[];

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn(TYPES, { each: true })
  type?: string[];

  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn(PRIORITIES, { each: true })
  priority?: string[];

  @IsOptional()
  @IsUUID('4')
  assignee_id?: string;

  @IsOptional()
  @IsUUID('4')
  group_id?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  unassigned?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  open?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  mine?: boolean;

  /**
   * The group queue (TM-08): every ticket assigned to a group the signed-in
   * person belongs to. The groups are read from op.group_members on the
   * server; the client never names them.
   */
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  my_groups?: boolean;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  breached?: boolean;

  /** The out-of-scope flag (TM-11): the Queue's Flagged chip and the waiting rail's link. */
  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsIn(OUT_OF_SCOPE, { each: true })
  out_of_scope?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsIn(['updated_desc', 'created_desc', 'priority'])
  sort?: 'updated_desc' | 'created_desc' | 'priority';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;

  @IsOptional()
  @IsString()
  cursor?: string;

  /** Saved view id; its conditions and sort apply. */
  @IsOptional()
  @IsUUID('4')
  view?: string;

  /** Inline condition set, base64url JSON of { conditions, match }. */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  conditions?: string;
}

/**
 * The out-of-scope flag and its decision (TM-11, Ticket Management
 * functional 5 and technical 4). Flagging states why in the client's words;
 * the decision either buys the work a budget allowance or declines it and
 * says so.
 */
export class ScopeFlagDto {
  @IsInt()
  @Min(1)
  version!: number;

  /** True flags the work as out of scope; false withdraws a flag still waiting for a decision. */
  @IsBoolean()
  out_of_scope!: boolean;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason?: string;
}

export class ScopeDecisionDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsIn(['approve', 'decline'])
  decision!: 'approve' | 'decline';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  /**
   * Minutes added to the contract period's budget when the work is
   * approved, so the time logged against the ticket is inside budget
   * instead of over it. Absent means "approved, no extra budget".
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  overage_allowance_minutes?: number;
}

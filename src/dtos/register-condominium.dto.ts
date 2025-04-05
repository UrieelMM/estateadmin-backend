import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { PlanType } from './register-client.dto';

export class RegisterCondominiumDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsNotEmpty()
  @IsString()
  address: string;

  @IsNotEmpty()
  @IsString()
  clientId: string;

  @IsOptional()
  @IsEnum(PlanType, {
    message: 'El plan debe ser Basic, Pro o Enterprise',
  })
  plan: PlanType = PlanType.Basic;

  @IsOptional()
  @IsArray()
  proFunctions: string[];
}

import { IsNotEmpty, IsString } from 'class-validator';

export class ClientPlanDto {
  @IsNotEmpty()
  @IsString()
  clientId: string;

  @IsNotEmpty()
  @IsString()
  condominiumId: string;
}

export class ClientPlanResponseDto {
  plan: string;
  proFunctions: string[];
}

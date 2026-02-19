import { Type } from 'class-transformer';
import { IsNotEmpty, IsString, IsOptional, ValidateNested, IsNumber } from 'class-validator';

export class MaintenanceFeesFileDto {
  @IsString()
  @IsNotEmpty()
  fileName: string;

  @IsString()
  @IsNotEmpty()
  filePath: string;
}


export class MaintenanceFeesDto {

  @IsNotEmpty()
  @IsString()
  email: string;

  @IsNotEmpty()
  @IsString()
  numberCondominium: string;

  @IsNotEmpty()
  @IsString()
  attachmentPayment: string;

  @IsNotEmpty()
  @IsString()

  @IsNotEmpty()
  @IsNumber()
  cargoTotal: string;

  @IsNotEmpty()
  @IsString()
  chargeId: string;

  @IsNotEmpty()
  @IsString()
  startAtStr: string;

  @IsNotEmpty()
  @IsString()
  dueDateStr: string;

  month: string;

  @IsNotEmpty()
  @IsString()
  startAt: string;

  @IsNotEmpty()
  @IsString()
  startAts: string;

  @IsOptional()
  @IsString()
  chargeAssignments: string;

  @IsString()
  paymentDate: string;

  @IsOptional()
  @IsString()
  paymentReference?: string;

  @IsString()
  financialAccountId: string;

  @IsString()
  useCreditBalance: string;

  @IsOptional()
  @IsString()
  comments: string;

  @IsOptional()
  isUnidentifiedPayment: boolean;

  @IsNotEmpty()
  @IsString()
  clientId: string;

  @IsNotEmpty()
  @IsString()
  condominiumId: string;

  @IsNotEmpty()
  @IsNumber()
  amountPaid: string;

  @IsNotEmpty()
  @IsOptional()
  paymentGroupId: string;

  @IsNotEmpty()
  paymentType: string;

  @IsNotEmpty()
  @IsNumber()
  amountPending: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => MaintenanceFeesFileDto)
  attachments?: MaintenanceFeesFileDto[];
}

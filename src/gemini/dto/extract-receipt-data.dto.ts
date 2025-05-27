import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty } from 'class-validator';

export class ExtractReceiptDataDto {
  @ApiProperty({
    description: 'Archivo de comprobante de pago (imagen o PDF)',
    type: 'string',
    format: 'binary',
    required: true,
  })
  @IsNotEmpty()
  file: any;
}

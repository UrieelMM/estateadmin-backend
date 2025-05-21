import { IsNotEmpty, IsString, IsOptional, IsNumber } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class QueryContextDto {
  @ApiProperty({
    description: 'Prompt para el que se desea obtener contexto relevante',
    example: '¿Cuáles son las reglas para mascotas en el condominio?',
  })
  @IsNotEmpty()
  @IsString()
  prompt: string;
  
  @ApiProperty({
    description: 'ID del cliente para filtrar el contexto',
    example: 'client123',
  })
  @IsNotEmpty()
  @IsString()
  clientId: string;

  @ApiProperty({
    description: 'ID del condominio para filtrar el contexto',
    example: 'cond123',
  })
  @IsNotEmpty()
  @IsString()
  condominiumId: string;

  @ApiProperty({
    description: 'Categoría para filtrar el contexto (opcional)',
    example: 'reglamento',
    required: false,
  })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiProperty({
    description: 'Número máximo de resultados a devolver',
    example: 20,
    default: 15,
    required: false,
  })
  @IsOptional()
  @IsNumber()
  maxResults?: number;
}

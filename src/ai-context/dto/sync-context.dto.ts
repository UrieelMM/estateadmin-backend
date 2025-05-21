import { IsNotEmpty, IsString, IsOptional, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SyncContextDto {
  @ApiProperty({
    description: 'Texto a vectorizar y almacenar en Pinecone',
    example: 'Esta es una información relevante sobre el condominio',
  })
  @IsNotEmpty()
  @IsString()
  text: string;

  @ApiProperty({
    description: 'Categoría o etiqueta para el contexto',
    example: 'reglamento',
  })
  @IsNotEmpty()
  @IsString()
  category: string;

  @ApiProperty({
    description: 'ID del cliente al que pertenece el contexto',
    example: 'client123',
  })
  @IsNotEmpty()
  @IsString()
  clientId: string;
  
  @ApiProperty({
    description: 'ID del condominio al que pertenece el contexto',
    example: 'cond123',
  })
  @IsNotEmpty()
  @IsString()
  condominiumId: string;

  @ApiProperty({
    description: 'Metadatos adicionales (opcional)',
    example: { source: 'manual', author: 'admin' },
    required: false,
  })
  @IsOptional()
  metadata?: Record<string, any>;
  
  // Permite propiedades adicionales (campos extras desde el frontend)
  [key: string]: any;
}

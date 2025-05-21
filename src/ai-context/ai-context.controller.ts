import { Controller, Post, Body, Logger, HttpException, HttpStatus, BadRequestException } from '@nestjs/common';
import { AiContextService } from './ai-context.service';
import { SyncContextDto } from './dto/sync-context.dto';
import { QueryContextDto } from './dto/query-context.dto';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('ai-context')
@Controller('ai-context')
export class AiContextController {
  private readonly logger = new Logger(AiContextController.name);
  
  constructor(private readonly aiContextService: AiContextService) {}

  @Post('sync')
  @ApiOperation({ summary: 'Sincroniza contexto con Pinecone usando embeddings de Gemini' })
  @ApiResponse({ 
    status: 201, 
    description: 'El contexto ha sido sincronizado correctamente',
  })
  @ApiResponse({ 
    status: 400, 
    description: 'Datos incorrectos o incompletos',
  })
  @ApiResponse({ 
    status: 500, 
    description: 'Error al sincronizar con Pinecone o generar embeddings',
  })
  async syncContext(@Body() syncContextDto: SyncContextDto) {
    try {
      this.logger.log(`Synchronizing context for condominiumId: ${syncContextDto.condominiumId}, category: ${syncContextDto.category}`);
      
      if (!syncContextDto.text || syncContextDto.text.trim().length === 0) {
        throw new BadRequestException('El texto no puede estar vacío');
      }
      
      return await this.aiContextService.syncContext(syncContextDto);
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      
      this.logger.error(`Error in syncContext endpoint: ${error.message}`);
      
      if (error.message.includes('El ID del condominio es obligatorio') ||
          error.message.includes('La categoría es obligatoria')) {
        throw new BadRequestException(error.message);
      }
      
      throw new HttpException(
        `Error al sincronizar contexto: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Post('query')
  @ApiOperation({ summary: 'Consulta contexto relevante y responde usando Gemini' })
  @ApiResponse({ 
    status: 200, 
    description: 'Respuesta generada con contexto relevante',
  })
  @ApiResponse({ 
    status: 400, 
    description: 'Datos incorrectos o incompletos',
  })
  @ApiResponse({ 
    status: 500, 
    description: 'Error al consultar Pinecone o generar respuesta con Gemini',
  })
  async queryContext(@Body() queryContextDto: QueryContextDto) {
    try {
      this.logger.log(`Querying context for condominiumId: ${queryContextDto.condominiumId}`);
      
      if (!queryContextDto.prompt || queryContextDto.prompt.trim().length === 0) {
        throw new BadRequestException('El prompt no puede estar vacío');
      }
      
      if (!queryContextDto.condominiumId) {
        throw new BadRequestException('El ID del condominio es obligatorio');
      }
      
      return await this.aiContextService.queryContext(queryContextDto);
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      
      this.logger.error(`Error in queryContext endpoint: ${error.message}`);
      
      if (error.message.includes('El prompt no puede estar vacío') ||
          error.message.includes('El ID del condominio es obligatorio')) {
        throw new BadRequestException(error.message);
      }
      
      throw new HttpException(
        `Error al consultar contexto: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}

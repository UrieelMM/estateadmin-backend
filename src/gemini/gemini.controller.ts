import {
  Controller,
  Post,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Res,
  ParseFilePipe,
  MaxFileSizeValidator,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { GeminiService } from './gemini.service';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Response } from 'express';
import { ExtractReceiptDataDto } from './dto/extract-receipt-data.dto';

import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
// GenerateContentDto might still be useful for Swagger definition, but not for body parsing here

@ApiTags('Gemini AI')
@Controller('gemini')
@UseGuards(ThrottlerGuard)
export class GeminiController {
  private readonly logger = new Logger(GeminiController.name);

  constructor(private readonly geminiService: GeminiService) {}

  @Post('generate-stream')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Generate content using Gemini API with streaming and optional file upload',
  })
  @ApiBody({
    // ApiBody still describes the expected structure
    description: 'Prompt and optional image file',
    required: true,
    schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        file: {
          type: 'string',
          format: 'binary',
          description:
            'Optional image file (JPG, PNG, WEBP, HEIC, HEIF are generally supported by Gemini)',
        },
      },
      required: ['prompt'], // Still required from the client perspective
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Stream of generated content chunks.',
  })
  @ApiResponse({ status: 429, description: 'Too Many Requests.' })
  @ApiResponse({ status: 500, description: 'Internal server error.' })
  @UseInterceptors(FileInterceptor('file'))
  async generateContentStream(
    @Body('prompt') prompt: string, // Extract 'prompt' field directly
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 })],
        fileIsRequired: false,
      }),
    )
    file: Express.Multer.File,
    @Res() res: Response,
  ) {
    // Validate prompt existence manually if needed (though required in ApiBody)
    if (!prompt) {
      this.logger.error('Prompt is missing in the request body.');
      // Send an appropriate error response before trying to stream
      res.status(400).json({ message: 'Prompt field is required.' });
      return;
    }

    this.logger.log(
      `Received stream request. Prompt: "${prompt.substring(0, 30)}..." File: ${file?.originalname}`,
    );

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      const resultStream = await this.geminiService.generateContentStream(
        prompt, // Use the extracted prompt variable
        file,
      );

      let fullResponseText = '';

      for await (const chunk of resultStream.stream) {
        const chunkText = chunk.text();
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
          fullResponseText += chunkText;
        } else {
          this.logger.warn('Stream closed prematurely by client.');
          break;
        }
      }

      this.logger.log(
        `Stream finished. Full response length: ${fullResponseText.length}`,
      );

      if (!res.writableEnded) {
        const usage = await resultStream.getUsage();
        res.write(
          `event: usage\ndata: ${JSON.stringify({
            type: 'usage',
            usage,
          })}\n\n`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Error during Gemini stream generation or processing: ${error.message}`,
        error.stack,
      );
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({ error: 'Failed to generate content', details: error.message })}\n\n`,
        );
      }
    } finally {
      if (!res.writableEnded) {
        res.end();
        this.logger.log('Response stream ended.');
      }
    }
  }

  @Post('extract-receipt')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Extraer datos estructurados de comprobantes de pago',
    description:
      'Procesa una imagen o PDF de un comprobante de pago y extrae información como monto, fecha, y más.',
  })
  @ApiBody({
    description: 'Archivo de comprobante de pago (imagen o PDF)',
    type: ExtractReceiptDataDto,
  })
  @ApiResponse({
    status: 200,
    description: 'Datos extraídos del comprobante',
    schema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Monto del pago' },
        currency: { type: 'string', description: 'Moneda (MXN, USD, etc)' },
        date: { type: 'string', description: 'Fecha del pago (YYYY-MM-DD)' },
        description: { type: 'string', description: 'Concepto o descripción del pago' },
        recipient: { type: 'string', description: 'Emisor o entidad que recibe el pago' },
        reference: { type: 'string', description: 'Número de referencia o folio' },
        paymentMethod: { type: 'string', description: 'Método de pago utilizado' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Solicitud inválida o archivo no soportado' })
  @ApiResponse({ status: 429, description: 'Demasiadas solicitudes' })
  @ApiResponse({ status: 500, description: 'Error interno del servidor' })
  @UseInterceptors(FileInterceptor('file'))
  async extractReceiptData(
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 10 * 1024 * 1024 })],
        fileIsRequired: true,
      }),
    )
    file: Express.Multer.File,
  ) {
    try {
      this.logger.log(`Recibida solicitud para extraer datos de comprobante: ${file?.originalname}`);
      const extractedData = await this.geminiService.extractReceiptData(file);
      return extractedData;
    } catch (error) {
      this.logger.error(
        `Error al procesar la solicitud de extracción de datos: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }
}

import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFiles,
  Req,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { PublicationsService } from './publications.service';
import { CreatePublicationDto } from 'src/dtos';
import { Throttle } from '@nestjs/throttler';

@Controller('publications')
export class PublicationsController {
  constructor(private readonly publicationsService: PublicationsService) {}

  private tryParseJSON(jsonString: any) {
    try {
      var o = JSON.parse(jsonString);
      if (o && typeof o === 'object') {
        return o;
      }
    } catch (e) {}

    return jsonString; // retorna la cadena original si falla el parseo
  }

  @Post('create')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseInterceptors(FilesInterceptor('attachments')) // Asegúrate de que 'attachments' coincide con el nombre del campo en el formulario
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async createPublication(@Req() req: Request, @UploadedFiles() files: any) {
    // Construye el DTO a partir de los datos del formulario
    let createPublicationDto: CreatePublicationDto = {
      title: req.body.title,
      content: req.body.content,
      author: req.body.author,
      clientId: req.body.clientId,
      tags: this.tryParseJSON(req.body.tags),
      condominiumName: req.body.condominiumName,
      condominiumId: req.body.condominiumId,
      sendTo: this.tryParseJSON(req.body.sendTo),
    };

    // Llama al servicio pasando el DTO y los archivos
    return await this.publicationsService.createPublication(
      createPublicationDto,
      files,
    );
  }
}

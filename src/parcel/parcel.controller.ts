import { Controller, Post, Req, UploadedFiles, UseInterceptors, UsePipes, ValidationPipe } from '@nestjs/common';
import { Request } from 'express';
import { ParcelService } from './parcel.service';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ParcelDto } from 'src/dtos';

@Controller('parcel')
export class ParcelController {
  constructor(private readonly parcelService: ParcelService) {}

  @Post('create')
  @UseInterceptors(FilesInterceptor('attachments')) // Asegúrate de que 'attachments' coincide con el nombre del campo en el formulario
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async createParcelReception(@Req() req: Request, @UploadedFiles() files: any) {
    // Construye el DTO a partir de los datos del formulario
    let parcelDto: ParcelDto = {
      email: req.body.email,
      receptor: req.body.receptor,
      condominiumId: req.body.condominiumId,
      clientId: req.body.clientId,
      recipientName: req.body.recipientName,
      dateReception: req.body.dateReception,
      hourReception: req.body.hourReception,
      comments: req.body.comments,
    };
    
    // Llama al servicio pasando el DTO y los archivos
    return await this.parcelService.createParcelReception(parcelDto, files);
  }
}

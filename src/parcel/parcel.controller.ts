import {
  Controller,
  Post,
  Req,
  UploadedFiles,
  UseInterceptors,
  UsePipes,
  ValidationPipe,
  Logger,
  Put,
  Body,
} from '@nestjs/common';
import { Request } from 'express';
import { ParcelService } from './parcel.service';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ParcelDto, UpdateParcelDto } from 'src/dtos';
import { Throttle } from '@nestjs/throttler';

@Controller('parcel')
export class ParcelController {
  private readonly logger = new Logger(ParcelController.name);
  constructor(private readonly parcelService: ParcelService) {}

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
  async createParcelReception(
    @Req() req: Request,
    @UploadedFiles() files: any,
  ) {
    try {
      this.logger.log(`Recibiendo petición de recepción de paquete. Email: ${req.body.email}, Files count: ${files?.length || 0}`);
      
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

      this.logger.log(`DTO construido correctamente: ${JSON.stringify(parcelDto)}`);
      
      // Llama al servicio pasando el DTO y los archivos
      const result = await this.parcelService.createParcelReception(parcelDto, files);
      this.logger.log(`Paquete registrado correctamente: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      this.logger.error(`Error al registrar paquete: ${error.message}`, error.stack);
      throw error;
    }
  }

  @Put('update')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseInterceptors(FilesInterceptor('deliveryAttachments'))
  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  async updateParcelDelivery(
    @Req() req: Request,
    @UploadedFiles() files: any,
  ) {
    try {
      this.logger.log(`Recibiendo petición de actualización de paquete. ID: ${req.body.parcelId}, Files count: ${files?.length || 0}`);
      
      // Construye el DTO a partir de los datos del formulario
      let updateParcelDto: UpdateParcelDto = {
        parcelId: req.body.parcelId,
        clientId: req.body.clientId,
        condominiumId: req.body.condominiumId,
        status: req.body.status,
        deliveryPerson: req.body.deliveryPerson,
        deliveredTo: req.body.deliveredTo,
        deliveryNotes: req.body.deliveryNotes,
        deliveryDate: req.body.deliveryDate,
        deliveryHour: req.body.deliveryHour,
      };

      this.logger.log(`DTO de actualización construido correctamente: ${JSON.stringify(updateParcelDto)}`);
      
      // Llama al servicio pasando el DTO y los archivos
      const result = await this.parcelService.updateParcelDelivery(updateParcelDto, files);
      this.logger.log(`Paquete actualizado correctamente: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      this.logger.error(`Error al actualizar paquete: ${error.message}`, error.stack);
      throw error;
    }
  }
}

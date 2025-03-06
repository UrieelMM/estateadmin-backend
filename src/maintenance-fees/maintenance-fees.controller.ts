import { Controller, Post, Req, UploadedFiles, UseInterceptors, UsePipes, ValidationPipe } from '@nestjs/common';
import { Request } from 'express';
import { MaintenanceFeesService } from './maintenance-fees.service';
import { FilesInterceptor } from '@nestjs/platform-express';
import { MaintenanceFeesDto } from 'src/dtos';

@Controller('maintenance-fees')
export class MaintenanceFeesController {
  constructor(private readonly maintenanceFeesService: MaintenanceFeesService) {}

  @Post('create')
  @UseInterceptors(FilesInterceptor('attachments')) // Asegúrate de que 'attachments' coincide con el nombre del campo en el formulario
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async createMaintenanceFees(@Req() req: Request, @UploadedFiles() files: any) {
  
    // Construye el DTO a partir de los datos del formulario
    let maintenanceFeeDto: MaintenanceFeesDto = {
      email: req.body.email,
      numberCondominium: req.body.numberCondominium,
      condominiumId: req.body.condominiumId,
      clientId: req.body.clientId,
      chargeAssignments: req.body.chargeAssignments,
      useCreditBalance: req.body.useCreditBalance,
      financialAccountId: req.body.financialAccountId,
      paymentDate: req.body.paymentDate,
      paymentType: req.body.paymentType,
      paymentGroupId: req.body.paymentGroupId,
      month: req.body.month,
      startAtStr: req.body.startAtStr,
      dueDateStr: req.body.dueDateStr,
      comments: req.body.comments,
      amountPaid: req.body.amountPaid,
      amountPending: req.body.amountPending,
      cargoTotal: req.body.cargoTotal,
      chargeId: req.body.chargeId
    };
    
    // Llama al servicio pasando el DTO y los archivos
    return await this.maintenanceFeesService.createMaintenanceFee(maintenanceFeeDto, files);
  }
}
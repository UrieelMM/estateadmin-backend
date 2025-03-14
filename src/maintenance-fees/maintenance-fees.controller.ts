import { 
  Controller, 
  Post, 
  Patch, 
  Req, 
  UploadedFiles, 
  UseInterceptors, 
  UsePipes, 
  ValidationPipe, 
  Body 
} from '@nestjs/common';
import { Request } from 'express';
import { MaintenanceFeesService } from './maintenance-fees.service';
import { FilesInterceptor } from '@nestjs/platform-express';
import { MaintenanceFeesDto } from 'src/dtos';
import { CreateUnidentifiedPaymentDto } from 'src/dtos/create-unidentified-payment.dto';
import { EditUnidentifiedPaymentDto } from 'src/dtos/edit-unidentified-payment.dto';

@Controller('maintenance-fees')
export class MaintenanceFeesController {
  constructor(private readonly maintenanceFeesService: MaintenanceFeesService) {}

  @Post('create')
  @UseInterceptors(FilesInterceptor('attachments'))
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async createMaintenanceFees(@Req() req: Request, @UploadedFiles() files: any) {
    let maintenanceFeeDto: MaintenanceFeesDto = {
      email: req.body.email,
      numberCondominium: req.body.numberCondominium,
      condominiumId: req.body.condominiumId,
      clientId: req.body.clientId,
      chargeAssignments: req.body.chargeAssignments,
      useCreditBalance: req.body.useCreditBalance,
      isUnidentifiedPayment: req.body.isUnidentifiedPayment,
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
      chargeId: req.body.chargeId,
      attachmentPayment: req.body.attachmentPayment
    };
    
    return await this.maintenanceFeesService.createMaintenanceFee(maintenanceFeeDto, files);
  }

  @Post('create-unidentified')
  @UseInterceptors(FilesInterceptor('attachments'))
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async createUnidentifiedPayment(@Req() req: Request, @UploadedFiles() files: any) {
    const unidentifiedPaymentDto: CreateUnidentifiedPaymentDto = {
      email: req.body.email,
      numberCondominium: req.body.numberCondominium,
      condominiumId: req.body.condominiumId,
      clientId: req.body.clientId,
      financialAccountId: req.body.financialAccountId,
      paymentDate: req.body.paymentDate,
      paymentType: req.body.paymentType,
      paymentGroupId: req.body.paymentGroupId,
      month: req.body.month,
      comments: req.body.comments,
      amountPaid: req.body.amountPaid,
      amountPending: req.body.amountPending,
      isUnidentifiedPayment: true,
      appliedToUser: req.body.appliedToUser ? req.body.appliedToUser : false,
      attachmentPayment: req.body.attachmentPayment,
      paymentId: req.body.paymentId,
      appliedToCondomino: req.body.appliedToCondomino,
    };

    return await this.maintenanceFeesService.createUnidentifiedPayment(unidentifiedPaymentDto, files);
  }

  // NUEVO ENDPOINT PARA "APLICAR" O EDITAR UN PAGO NO IDENTIFICADO
  @Patch('edit-unidentified')
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  async editUnidentifiedPayment(@Body() dto: EditUnidentifiedPaymentDto) {
    return await this.maintenanceFeesService.editUnidentifiedPayment(dto);
  }
}

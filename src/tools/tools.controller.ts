import { Controller, Post, Body, Get, Param, UseGuards, Query, BadRequestException } from '@nestjs/common';
import { ToolsService } from './tools.service';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ClientPlanDto } from 'src/dtos/client-plan.dto';
import { 
  SearchPlacesDto, 
  ContactFormDto, 
  NewCustomerInfoDto, 
  FormExpirationDto, 
  FormUrlDto,
  PaginationQueryDto
} from 'src/dtos/tools';

@Controller('tools')
@UseGuards(ThrottlerGuard)
export class ToolsController {
  constructor(private readonly toolsService: ToolsService) {}

  @Post('places')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async searchPlaces(@Body() searchPlacesDto: SearchPlacesDto) {
    return this.toolsService.searchPlaces(
      searchPlacesDto.latitude,
      searchPlacesDto.longitude,
      searchPlacesDto.keyword,
      searchPlacesDto.radius,
    );
  }

  @Get('places/:placeId')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async getPlaceDetails(@Param('placeId') placeId: string) {
    return this.toolsService.getPlaceDetails(placeId);
  }

  @Post('client-plan')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async getClientPlan(@Body() clientPlanDto: ClientPlanDto) {
    return this.toolsService.getClientPlan(
      clientPlanDto.clientId,
      clientPlanDto.condominiumId,
    );
  }

  @Post('contact-form')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async submitContactForm(@Body() contactFormDto: ContactFormDto) {
    console.log(
      'Datos recibidos en el controlador:',
      JSON.stringify(contactFormDto),
    );

    // Asegurarse de que los valores existen antes de pasarlos al servicio
    const name = contactFormDto.name || '';
    const email = contactFormDto.email || '';
    const phone = contactFormDto.phone || '';
    const message = contactFormDto.message || '';

    return this.toolsService.submitContactForm(name, email, phone, message);
  }

  @Post('new-customer-information')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async submitNewCustomerInfo(@Body() newCustomerInfoDto: NewCustomerInfoDto) {
    console.log(
      'Datos de nuevo cliente recibidos en el controlador:',
      JSON.stringify(newCustomerInfoDto),
    );

    return this.toolsService.submitNewCustomerInfo(newCustomerInfoDto);
  }

  @Post('new-customer-information/:formId')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async submitNewCustomerInfoWithFormId(
    @Param('formId') formId: string,
    @Body() newCustomerInfoDto: NewCustomerInfoDto
  ) {
    console.log(
      `Datos de nuevo cliente recibidos en el controlador con formId: ${formId}`,
      JSON.stringify(newCustomerInfoDto),
    );

    // Aseguramos que el recordId esté presente en el DTO
    if (!newCustomerInfoDto.recordId) {
      newCustomerInfoDto.recordId = formId;
    }

    return this.toolsService.submitNewCustomerInfo(newCustomerInfoDto);
  }

  @Get('check-form-expiration')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async checkFormExpiration(@Query('formId') formId: string) {
    console.log(
      'Verificando expiración del formulario:',
      formId,
    );

    if (!formId) {
      throw new BadRequestException('El parámetro formId es obligatorio');
    }

    return this.toolsService.checkFormExpiration(formId);
  }

  @Post('generate-form-url')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async generateFormUrl(@Body() formUrlDto: FormUrlDto) {
    console.log(
      'Generando URL para el formulario:',
      formUrlDto.formId,
    );

    return this.toolsService.generateFormUrl(formUrlDto);
  }

  @Get('customer-information')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async getCustomerInformation(@Query() paginationQuery: PaginationQueryDto) {
    console.log(
      'Obteniendo información de clientes:',
      `página ${paginationQuery.page}, ${paginationQuery.perPage} por página`,
    );

    return this.toolsService.getCustomerInformation(
      paginationQuery.page,
      paginationQuery.perPage
    );
  }

  @Get('form-urls')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  async getFormUrls(@Query() paginationQuery: PaginationQueryDto) {
    console.log(
      'Obteniendo URLs de formularios:',
      `página ${paginationQuery.page}, ${paginationQuery.perPage} por página`,
    );

    return this.toolsService.getFormUrls(
      paginationQuery.page,
      paginationQuery.perPage
    );
  }
}

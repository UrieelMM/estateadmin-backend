import { Controller, Post, Body, Get, Param, UseGuards } from '@nestjs/common';
import { ToolsService } from './tools.service';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ClientPlanDto } from 'src/dtos/client-plan.dto';
import { SearchPlacesDto, ContactFormDto } from 'src/dtos/tools';

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
}

import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  UseGuards,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { ToolsService } from './tools.service';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ClientPlanDto } from 'src/dtos/client-plan.dto';

class SearchPlacesDto {
  latitude: number;
  longitude: number;
  keyword: string;
  radius: number;
}

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
}

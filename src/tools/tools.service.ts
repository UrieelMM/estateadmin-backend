import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import axios from 'axios';
import * as admin from 'firebase-admin';
import { ClientPlanResponseDto } from 'src/dtos/client-plan.dto';

@Injectable()
export class ToolsService {
  private readonly GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

  async searchPlaces(
    latitude: number,
    longitude: number,
    keyword: string,
    radius: number,
  ) {
    try {
      const response = await axios.get(
        `https://maps.googleapis.com/maps/api/place/nearbysearch/json`,
        {
          params: {
            location: `${latitude},${longitude}`,
            radius: radius,
            keyword: keyword,
            language: 'es',
            key: this.GOOGLE_PLACES_API_KEY,
          },
        },
      );

      return response.data;
    } catch (error) {
      throw new Error(`Error al buscar lugares: ${error.message}`);
    }
  }

  async getPlaceDetails(placeId: string) {
    try {
      const response = await axios.get(
        `https://maps.googleapis.com/maps/api/place/details/json`,
        {
          params: {
            place_id: placeId,
            language: 'es',
            fields: [
              'address_components',
              'adr_address',
              'formatted_address',
              'geometry',
              'icon',
              'name',
              'opening_hours',
              'photos',
              'place_id',
              'plus_code',
              'formatted_phone_number',
              'international_phone_number',
              'website',
              'rating',
              'reviews',
              'price_level',
              'business_status',
              'types',
              'url',
              'user_ratings_total',
            ].join(','),
            key: this.GOOGLE_PLACES_API_KEY,
          },
        },
      );

      return response.data;
    } catch (error) {
      throw new Error(`Error al obtener detalles del lugar: ${error.message}`);
    }
  }

  async getClientPlan(
    clientId: string,
    condominiumId: string,
  ): Promise<ClientPlanResponseDto> {
    try {
      // Obtener datos del condominio desde Firestore
      const condominiumDoc = await admin
        .firestore()
        .collection(`clients/${clientId}/condominiums`)
        .doc(condominiumId)
        .get();

      if (!condominiumDoc.exists) {
        throw new NotFoundException(
          `Condominio con ID ${condominiumId} no encontrado`,
        );
      }

      const condominiumData = condominiumDoc.data();

      return {
        plan: condominiumData.plan || 'Basic', // Valor por defecto si no existe
        proFunctions: condominiumData.proFunctions || [], // Valor por defecto si no existe
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new Error(
        `Error al obtener el plan del condominio: ${error.message}`,
      );
    }
  }
}

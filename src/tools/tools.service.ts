import { Injectable } from '@nestjs/common';
import axios from 'axios';

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
}

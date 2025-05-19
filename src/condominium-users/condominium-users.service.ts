import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CondominiumLimitResponseDto } from 'src/dtos/tools/condominium-limit.dto';
import * as admin from 'firebase-admin';

@Injectable()
export class CondominiumUsersService {
  private readonly logger = new Logger(CondominiumUsersService.name);

  async getCondominiumLimit(
    clientId: string,
    condominiumId: string,
  ): Promise<CondominiumLimitResponseDto> {
    try {
      // Verificar que los parámetros no estén vacíos
      if (!clientId || !condominiumId) {
        throw new NotFoundException('ClientId y CondominiumId son requeridos');
      }
      
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
      // Valor por defecto de 50 si no existe condominiumLimit
      const condominiumLimit = condominiumData?.condominiumLimit || 50;

      this.logger.log(`Límite de condóminos para el condominio ${condominiumId}: ${condominiumLimit}`);
      return { condominiumLimit };
    } catch (error) {
      this.logger.error(`Error al obtener el límite de condóminos: ${error.message}`, error.stack);
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new Error(
        `Error al obtener el límite de condóminos: ${error.message}`,
      );
    }
  }

  async getCondominiumUsers(clientId: string, condominiumId: string) {
    try {
      // Verificar que los parámetros no estén vacíos
      if (!clientId || !condominiumId) {
        throw new NotFoundException('ClientId y CondominiumId son requeridos');
      }

      // Referencia a la colección de usuarios del condominio
      const usersRef = admin
        .firestore()
        .collection(`clients/${clientId}/condominiums/${condominiumId}/users`);
      
      // Obtener todos los documentos de la colección
      const snapshot = await usersRef.get();
      
      if (snapshot.empty) {
        return [];
      }

      // Mapear los documentos para devolver solo id y role (minimizando exposición de datos sensibles)
      const users = snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          id: doc.id,
          role: data.role || 'condominium'
        };
      });

      this.logger.log(`Se encontraron ${users.length} usuarios para el condominio ${condominiumId}`);
      return users;
    } catch (error) {
      this.logger.error(`Error al obtener usuarios del condominio: ${error.message}`, error.stack);
      throw error;
    }
  }
}

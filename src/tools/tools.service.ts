import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import axios from 'axios';
import * as admin from 'firebase-admin';
import { ClientPlanResponseDto } from 'src/dtos/client-plan.dto';
import {
  NewCustomerInfoDto,
  FormExpirationResponseDto,
  FormUrlResponseDto,
  FormUrlDto,
} from 'src/dtos/tools';

@Injectable()
export class ToolsService {
  private readonly GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

  /**
   * Obtiene datos paginados de la colección newCustomerInformationForm
   * @param page Número de página a obtener
   * @param perPage Cantidad de elementos por página
   * @returns Respuesta paginada con la información de clientes
   */
  async getCustomerInformation(page: number = 1, perPage: number = 10) {
    try {
      // Validar y ajustar parámetros
      page = Math.max(1, page);
      perPage = Math.min(100, Math.max(1, perPage)); // Máximo 100 elementos por página

      // Calcular índice de inicio para paginación
      const startIndex = (page - 1) * perPage;

      // Obtener un elemento más para determinar si hay página siguiente
      const query = admin
        .firestore()
        .collection('newCustomerInformationForm')
        .orderBy('registrationDate', 'desc')
        .limit(perPage + 1);

      // Ejecutar consulta
      const snapshot = await query.get();
      const items = [];

      // Procesar resultados
      let count = 0;
      let hasNextPage = false;

      snapshot.forEach((doc) => {
        // Si ya tenemos los elementos necesarios para la página, solo marcamos que hay página siguiente
        if (count >= perPage) {
          hasNextPage = true;
          return;
        }

        // Añadir datos con ID del documento
        const data = doc.data();
        items.push({
          id: doc.id,
          ...data,
          // Convertir timestamps a formato ISO para facilitar el manejo en el frontend
          registrationDate: data.registrationDate
            ? data.registrationDate.toDate().toISOString()
            : null,
        });

        count++;
      });

      // Consulta para obtener el total de documentos (para el conteo total)
      // Nota: Esta consulta adicional puede ser costosa en colecciones grandes
      const totalItems = (
        await admin.firestore().collection('newCustomerInformationForm').get()
      ).size;
      const totalPages = Math.ceil(totalItems / perPage);

      // Construir respuesta
      return {
        data: items,
        meta: {
          currentPage: page,
          perPage,
          totalItems,
          totalPages,
          hasNextPage,
          hasPrevPage: page > 1,
        },
      };
    } catch (error) {
      throw new Error(
        `Error al obtener información de clientes: ${error.message}`,
      );
    }
  }

  /**
   * Obtiene datos paginados de la colección formUrls
   * @param page Número de página a obtener
   * @param perPage Cantidad de elementos por página
   * @returns Respuesta paginada con la información de URLs de formularios
   */
  async getFormUrls(page: number = 1, perPage: number = 10) {
    try {
      // Validar y ajustar parámetros
      page = Math.max(1, page);
      perPage = Math.min(100, Math.max(1, perPage)); // Máximo 100 elementos por página

      // Calcular índice de inicio para paginación
      const startIndex = (page - 1) * perPage;

      // Obtener un elemento más para determinar si hay página siguiente
      const query = admin
        .firestore()
        .collection('formUrls')
        .orderBy('createdAt', 'desc')
        .limit(perPage + 1);

      // Ejecutar consulta
      const snapshot = await query.get();
      const items = [];

      // Procesar resultados
      let count = 0;
      let hasNextPage = false;

      snapshot.forEach((doc) => {
        // Si ya tenemos los elementos necesarios para la página, solo marcamos que hay página siguiente
        if (count >= perPage) {
          hasNextPage = true;
          return;
        }

        // Añadir datos con ID del documento
        const data = doc.data();
        items.push({
          id: doc.id,
          ...data,
          // Convertir timestamps a formato ISO para facilitar el manejo en el frontend
          createdAt: data.createdAt
            ? data.createdAt.toDate().toISOString()
            : null,
          expirationDate: data.expirationDate
            ? data.expirationDate.toDate().toISOString()
            : null,
          usedAt: data.usedAt ? data.usedAt.toDate().toISOString() : null,
        });

        count++;
      });

      // Consulta para obtener el total de documentos (para el conteo total)
      // Nota: Esta consulta adicional puede ser costosa en colecciones grandes
      const totalItems = (await admin.firestore().collection('formUrls').get())
        .size;
      const totalPages = Math.ceil(totalItems / perPage);

      // Construir respuesta
      return {
        data: items,
        meta: {
          currentPage: page,
          perPage,
          totalItems,
          totalPages,
          hasNextPage,
          hasPrevPage: page > 1,
        },
      };
    } catch (error) {
      throw new Error(`Error al obtener URLs de formularios: ${error.message}`);
    }
  }

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

  async submitContactForm(
    name: string,
    email: string,
    phone?: string,
    message?: string,
  ) {
    try {
      // Validate required fields
      if (!name || name.trim() === '' || !email || email.trim() === '') {
        throw new Error('El nombre y el email son campos obligatorios');
      }

      // Create a new contact form entry with the current timestamp
      const contactFormData: Record<string, any> = {
        name: name.trim(),
        email: email.trim(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Añadir campos opcionales solo si tienen valor
      if (phone !== undefined && phone !== null && phone.trim() !== '') {
        contactFormData.phone = phone.trim();
      }

      if (message !== undefined && message !== null && message.trim() !== '') {
        contactFormData.message = message.trim();
      }

      // Insert the data into the specified collection
      const result = await admin
        .firestore()
        .collection('administration/users/emailsToContact')
        .add(contactFormData);

      return {
        success: true,
        id: result.id,
        message: 'Contact form submitted successfully',
      };
    } catch (error) {
      throw new Error(`Error submitting contact form: ${error.message}`);
    }
  }

  /**
   * Valida y sanitiza un string eliminando caracteres potencialmente peligrosos
   * @param value String a sanitizar
   * @returns String sanitizado
   */
  private sanitizeString(value: string): string {
    if (!value) return '';

    // Eliminar etiquetas HTML, scripts y caracteres peligrosos
    let sanitized = value
      .replace(/<[^>]*>/g, '') // Eliminar tags HTML
      .replace(
        /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F1E0}-\u{1F1FF}]/gu,
        '',
      ) // Eliminar emojis
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Eliminar caracteres de control
      .replace(
        /script|javascript|alert|confirm|prompt|eval|Function|setTimeout|setInterval|onload|onclick|onerror/gi,
        '',
      ); // Eliminar palabras relacionadas con JS

    // Eliminar palabras típicas de SQL Injection
    sanitized = sanitized.replace(
      /SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|JOIN|UNION|WHERE|FROM|INTO/gi,
      '',
    );

    return sanitized.trim();
  }

  /**
   * Maneja el registro de información de nuevos clientes en la base de datos
   * @param newCustomerInfo Información del nuevo cliente
   * @returns Resultado de la operación
   */
  /**
   * Genera y registra una URL de formulario para compartir con clientes
   * @param formUrlDto DTO con la información para generar la URL
   * @returns Resultado de la operación con la información de la URL
   */
  async generateFormUrl(formUrlDto: FormUrlDto): Promise<FormUrlResponseDto> {
    try {
      // Validar que se proporcionó un ID de formulario
      if (!formUrlDto.formId) {
        throw new BadRequestException('El ID del formulario es obligatorio');
      }

      const formId = this.sanitizeString(formUrlDto.formId);

      // Crear objeto con los datos de la URL del formulario
      const formUrlData: Record<string, any> = {
        formId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'active',
      };

      // Añadir campos opcionales si se proporcionaron
      if (formUrlDto.clientName) {
        formUrlData.clientName = this.sanitizeString(formUrlDto.clientName);
      }

      if (formUrlDto.notes) {
        formUrlData.notes = this.sanitizeString(formUrlDto.notes);
      }

      // Calcular fecha de expiración (7 días a partir de ahora)
      const expirationDate = new Date();
      expirationDate.setDate(expirationDate.getDate() + 7);
      formUrlData.expirationDate =
        admin.firestore.Timestamp.fromDate(expirationDate);

      // Guardar en Firestore en una colección dedicada para URLs de formularios
      const result = await admin
        .firestore()
        .collection('formUrls')
        .add(formUrlData);

      console.log(
        `URL de formulario generada con ID: ${result.id} para formId: ${formId}`,
      );

      return {
        success: true,
        formId,
        createdAt: new Date().toISOString(),
        message: 'URL de formulario generada exitosamente',
        expirationDate: expirationDate.toISOString(),
      };
    } catch (error) {
      console.error('Error al generar URL de formulario:', error);

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new Error(`Error al generar URL de formulario: ${error.message}`);
    }
  }

  /**
   * Verifica si un formulario ha expirado basado en su fecha de registro
   * @param formId ID del formulario a verificar
   * @returns Información sobre el estado de expiración del formulario
   */
  async checkFormExpiration(
    formId: string,
  ): Promise<FormExpirationResponseDto> {
    try {
      // Validar que se proporcionó un ID de formulario
      if (!formId) {
        throw new BadRequestException('El ID del formulario es obligatorio');
      }

      console.log(`Buscando formulario con ID: ${formId}`);

      // Primero intentamos buscar en la colección formUrls (donde se guardan las URLs generadas)
      const formUrlsQuery = await admin
        .firestore()
        .collection('formUrls')
        .where('formId', '==', formId)
        .limit(1)
        .get();

      // Si encontramos un documento en formUrls, lo usamos
      if (!formUrlsQuery.empty) {
        console.log('Encontrado en formUrls');
        const formUrlDoc = formUrlsQuery.docs[0];
        const formUrlData = formUrlDoc.data();

        // Validar si el formulario ya ha sido usado
        if (formUrlData.status === 'used') {
          return {
            expired: true,
            formId,
            message: 'El formulario ya ha sido utilizado',
            usedAt: formUrlData.usedAt
              ? formUrlData.usedAt.toDate().toISOString()
              : new Date().toISOString(),
          };
        }

        // Si tiene fecha de expiración explícita, la usamos
        if (formUrlData.expirationDate) {
          const expirationDate = formUrlData.expirationDate.toDate();
          const currentDate = new Date();
          const expired = currentDate > expirationDate;

          // Calcular días restantes
          const differenceInTime =
            expirationDate.getTime() - currentDate.getTime();
          const daysRemaining = Math.max(
            0,
            Math.floor(differenceInTime / (1000 * 3600 * 24)),
          );

          return {
            expired,
            formId,
            message: expired
              ? 'El formulario ha expirado'
              : `El formulario está disponible por ${daysRemaining} día(s) más`,
            expirationDate: expirationDate.toISOString(),
            daysRemaining,
          };
        }

        // Si tiene createdAt pero no expirationDate, calculamos la expiración
        if (formUrlData.createdAt) {
          const createdAt = formUrlData.createdAt.toDate();
          const currentDate = new Date();

          // Calcular fecha de expiración (7 días después de createdAt)
          const expirationDate = new Date(createdAt);
          expirationDate.setDate(expirationDate.getDate() + 7);

          const expired = currentDate > expirationDate;
          const differenceInTime =
            expirationDate.getTime() - currentDate.getTime();
          const daysRemaining = Math.max(
            0,
            Math.floor(differenceInTime / (1000 * 3600 * 24)),
          );

          return {
            expired,
            formId,
            message: expired
              ? 'El formulario ha expirado'
              : `El formulario está disponible por ${daysRemaining} día(s) más`,
            expirationDate: expirationDate.toISOString(),
            daysRemaining,
          };
        }
      }

      // Si no encontramos nada en formUrls o no tiene fechas, buscamos en newCustomerInformationForm
      const formDoc = await admin
        .firestore()
        .collection('newCustomerInformationForm')
        .doc(formId)
        .get();

      // Verificar si el documento existe
      if (!formDoc.exists) {
        // Si llegamos aquí, significa que no encontramos el formulario en ninguna colección
        throw new NotFoundException(
          `No se encontró un formulario con ID: ${formId}`,
        );
      }

      // Obtener los datos del formulario
      const formData = formDoc.data();

      // Si no hay fecha de registro, considerar como expirado por seguridad
      if (!formData.registrationDate) {
        return {
          expired: true,
          formId,
          message: 'El formulario ha expirado (no tiene fecha de registro)',
        };
      }

      // Convertir el timestamp de Firestore a Date
      const registrationDate = formData.registrationDate.toDate();
      const currentDate = new Date();

      // Calcular la diferencia en días
      const differenceInTime =
        currentDate.getTime() - registrationDate.getTime();
      const differenceInDays = Math.floor(
        differenceInTime / (1000 * 3600 * 24),
      );

      // Calcular la fecha de expiración (7 días después del registro)
      const expirationDate = new Date(registrationDate);
      expirationDate.setDate(expirationDate.getDate() + 7);

      // Determinar si ha expirado
      const expired = differenceInDays >= 7;
      const daysRemaining = Math.max(0, 7 - differenceInDays);

      return {
        expired,
        formId,
        message: expired
          ? 'El formulario ha expirado'
          : `El formulario está disponible por ${daysRemaining} día(s) más`,
        expirationDate: expirationDate.toISOString(),
        daysRemaining: expired ? 0 : daysRemaining,
      };
    } catch (error) {
      console.error('Error al verificar expiración del formulario:', error);

      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }

      throw new Error(
        `Error al verificar expiración del formulario: ${error.message}`,
      );
    }
  }

  async submitNewCustomerInfo(newCustomerInfo: NewCustomerInfoDto) {
    try {
      console.log('Procesando información de nuevo cliente:', {
        name: newCustomerInfo.name,
        email: newCustomerInfo.email,
        company: newCustomerInfo.companyName,
        recordId: newCustomerInfo.recordId,
      });

      // Guardar el ID del formulario si fue enviado desde el frontend
      const formId = newCustomerInfo.recordId || null;

      // Sanitizar todos los campos de texto
      const sanitizedData: Record<string, any> = {};

      // Sanitizar campos obligatorios
      sanitizedData.name = this.sanitizeString(newCustomerInfo.name);
      sanitizedData.lastName = this.sanitizeString(newCustomerInfo.lastName);
      sanitizedData.email = this.sanitizeString(newCustomerInfo.email);
      sanitizedData.phoneNumber = this.sanitizeString(
        newCustomerInfo.phoneNumber,
      );
      sanitizedData.companyName = this.sanitizeString(
        newCustomerInfo.companyName,
      );
      sanitizedData.fullFiscalAddress = this.sanitizeString(
        newCustomerInfo.fullFiscalAddress,
      );
      sanitizedData.RFC = this.sanitizeString(newCustomerInfo.RFC);
      sanitizedData.country = this.sanitizeString(newCustomerInfo.country);
      sanitizedData.businessName = this.sanitizeString(
        newCustomerInfo.businessName,
      );
      sanitizedData.taxRegime = this.sanitizeString(newCustomerInfo.taxRegime);
      sanitizedData.businessActivity = this.sanitizeString(
        newCustomerInfo.businessActivity,
      );
      sanitizedData.responsiblePersonName = this.sanitizeString(
        newCustomerInfo.responsiblePersonName,
      );
      sanitizedData.responsiblePersonPosition = this.sanitizeString(
        newCustomerInfo.responsiblePersonPosition,
      );

      // Sanitizar información del condominio
      sanitizedData.condominiumInfo = {
        name: this.sanitizeString(newCustomerInfo.condominiumInfo.name),
        address: this.sanitizeString(newCustomerInfo.condominiumInfo.address),
      };

      // Sanitizar campos opcionales (si existen)
      if (newCustomerInfo.photoURL) {
        sanitizedData.photoURL = this.sanitizeString(newCustomerInfo.photoURL);
      }

      if (newCustomerInfo.cfdiUse) {
        sanitizedData.cfdiUse = this.sanitizeString(newCustomerInfo.cfdiUse);
      }

      // Guardar siempre el recordId/formId como parte del documento para referencia futura
      if (newCustomerInfo.recordId) {
        sanitizedData.recordId = this.sanitizeString(newCustomerInfo.recordId);
        // También lo guardamos como formId explícitamente para claridad
        sanitizedData.formId = this.sanitizeString(newCustomerInfo.recordId);
      } else if (formId) {
        sanitizedData.formId = formId;
        sanitizedData.recordId = formId;
      }

      // Validar que todos los campos requeridos estén presentes después de sanitizar
      const requiredFields = [
        'name',
        'lastName',
        'email',
        'phoneNumber',
        'companyName',
        'fullFiscalAddress',
        'RFC',
        'country',
        'businessName',
        'taxRegime',
        'businessActivity',
        'responsiblePersonName',
        'responsiblePersonPosition',
      ];

      for (const field of requiredFields) {
        if (!sanitizedData[field]) {
          throw new BadRequestException(
            `El campo ${field} es obligatorio y no puede estar vacío`,
          );
        }
      }

      // Validar los campos del condominio
      if (
        !sanitizedData.condominiumInfo.name ||
        !sanitizedData.condominiumInfo.address
      ) {
        throw new BadRequestException(
          'La información del condominio es obligatoria',
        );
      }

      // Añadir valores predeterminados para campos opcionales
      sanitizedData.plan = newCustomerInfo.plan || 'Basic';
      sanitizedData.billingFrequency =
        newCustomerInfo.billingFrequency || 'monthly';

      // Añadir la fecha de registro
      sanitizedData.registrationDate =
        admin.firestore.FieldValue.serverTimestamp();

      // Si se proporcionó un ID de formulario, guardarlo
      if (formId) {
        sanitizedData.formId = formId;
      }

      // Buscar primero el documento en formUrls para obtener su ID
      let formUrlDocId = null;
      if (formId) {
        try {
          const formUrlsQuery = await admin
            .firestore()
            .collection('formUrls')
            .where('formId', '==', formId)
            .limit(1)
            .get();

          if (!formUrlsQuery.empty) {
            formUrlDocId = formUrlsQuery.docs[0].id;
            console.log(
              `Encontrado formUrlDocId: ${formUrlDocId} para formId: ${formId}`,
            );
          }
        } catch (error) {
          console.error(
            `Error al buscar formUrlDocId para formId ${formId}:`,
            error,
          );
        }
      }

      // Insertar los datos en la colección especificada usando el mismo ID si está disponible
      let result;
      if (formUrlDocId) {
        // Usar el mismo ID de documento que en formUrls
        result = await admin
          .firestore()
          .collection('newCustomerInformationForm')
          .doc(formUrlDocId)
          .set(sanitizedData);

        console.log(`Creado documento con ID existente: ${formUrlDocId}`);
        // Devolver un objeto con estructura similar a DocumentReference
        result = { id: formUrlDocId };
      } else {
        // Si no hay ID o no se encontró, generar uno nuevo con add()
        result = await admin
          .firestore()
          .collection('newCustomerInformationForm')
          .add(sanitizedData);
      }

      // Guardar en el log los datos para depuración
      console.log('Datos antes de actualizar formUrls:', {
        formId,
        resultId: result.id,
        formUrlDocId: formUrlDocId || 'no disponible',
        sanitizedFormId: sanitizedData.formId || 'no guardado',
      });

      // Actualizar el estado del formulario en formUrls con más robustez
      try {
        // Primero intentamos con formUrlDocId (si lo tenemos de antes)
        if (formUrlDocId) {
          await admin
            .firestore()
            .collection('formUrls')
            .doc(formUrlDocId)
            .update({
              status: 'used',
              active: false,
              usedAt: admin.firestore.FieldValue.serverTimestamp(),
              customerInfoId: result.id, // Referencia al documento creado
              lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
            });

          console.log(
            `Formulario con ID ${formUrlDocId} marcado como usado usando ID directo`,
          );
          return {
            success: true,
            id: result.id,
            message: 'Información de nuevo cliente registrada exitosamente',
            registrationDate: new Date().toISOString(),
            formUpdated: true,
          };
        }

        // Si no tenemos formUrlDocId, buscamos por formId
        if (formId) {
          // Buscar el documento en formUrls por formId
          const formUrlsQuery = await admin
            .firestore()
            .collection('formUrls')
            .where('formId', '==', formId)
            .limit(1)
            .get();

          if (!formUrlsQuery.empty) {
            const formUrlDoc = formUrlsQuery.docs[0];

            // Actualizar el estado a 'used'
            await admin
              .firestore()
              .collection('formUrls')
              .doc(formUrlDoc.id)
              .update({
                status: 'used',
                active: false,
                usedAt: admin.firestore.FieldValue.serverTimestamp(),
                customerInfoId: result.id, // Referencia al documento creado
                lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
              });

            console.log(
              `Formulario ${formId} marcado como usado usando formId`,
            );
            return {
              success: true,
              id: result.id,
              message: 'Información de nuevo cliente registrada exitosamente',
              registrationDate: new Date().toISOString(),
              formUpdated: true,
            };
          } else {
            console.warn(
              `No se encontró formulario con formId: ${formId} en formUrls`,
            );
          }
        }

        // Si llegamos aquí, no se pudo actualizar el formulario
        console.warn(
          'No se pudo actualizar el estado del formulario en formUrls',
        );
      } catch (error) {
        console.error('Error al actualizar el estado del formulario:', error);
        // No interrumpimos el flujo principal si hay error al actualizar el estado
      }

      return {
        success: true,
        id: result.id,
        message: 'Información de nuevo cliente registrada exitosamente',
        registrationDate: new Date().toISOString(),
      };
    } catch (error) {
      console.error('Error al registrar nuevo cliente:', error);

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new Error(
        `Error al registrar información del cliente: ${error.message}`,
      );
    }
  }
}

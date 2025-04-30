import { InternalServerErrorException, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { format } from 'date-fns';
import { UpdateParcelDto } from 'src/dtos';

const logger = new Logger('UpdateParcelCase');

export const UpdateParcelCase = async (
  updateParcelDto: UpdateParcelDto,
  files: any,
) => {
  logger.log(`Iniciando caso de uso UpdateParcelCase con datos: ${JSON.stringify(updateParcelDto)}`);
  logger.log(`Archivos recibidos: ${files?.length || 0}`);
  
  const {
    parcelId,
    clientId,
    condominiumId,
    status,
    deliveryPerson,
    deliveredTo,
    deliveryNotes,
    deliveryDate,
    deliveryHour,
  } = updateParcelDto;

  if (!condominiumId || !clientId || !parcelId) {
    logger.error('No se ha proporcionado un condominiumId, clientId o parcelId válido.');
    throw new InternalServerErrorException('No se ha proporcionado un condominiumId, clientId o parcelId válido.');
  }

  try {
    // Subir archivos de evidencia si existen
    const datePath = format(new Date(), 'yyyy-MM-dd');
    const bucket = admin.storage().bucket("administracioncondominio-93419.appspot.com");
    let attachmentUrls = [];

    if (files && files.length > 0) {
      logger.log(`Preparando subida de archivos a bucket: ${bucket.name}`);
      
      // Ajustar la ruta de subida de archivos para incluir condominiumId
      const uploadPromises = files.map((file) => {
        const fileUploadPath = `clients/${clientId}/condominiums/${condominiumId}/parcelDeliveries/${datePath}/${file.originalname}`;
        logger.log(`Subiendo archivo: ${file.originalname} a ruta: ${fileUploadPath}`);
        
        const blob = bucket.file(fileUploadPath);

        return new Promise((resolve, reject) => {
          const blobStream = blob.createWriteStream({
            metadata: {
              contentType: file.mimetype,
            },
            public: true,
          });

          blobStream.on('error', (error) => {
            logger.error(`Error en blobStream: ${error.message}`, error.stack);
            reject(error);
          });

          blobStream.on('finish', async () => {
            const publicUrl = `https://storage.googleapis.com/${bucket.name}/${blob.name}`;
            logger.log(`Archivo subido correctamente. URL pública: ${publicUrl}`);
            resolve(publicUrl);
          });

          blobStream.end(file.buffer);
        });
      });

      logger.log('Esperando a que se completen todas las subidas de archivos...');
      attachmentUrls = await Promise.all(uploadPromises);
      logger.log(`Subidas completadas. URLs generadas: ${attachmentUrls.length}`);
    }

    // Obtener referencia al documento del paquete
    const parcelRef = admin.firestore()
      .collection('clients')
      .doc(clientId)
      .collection('condominiums')
      .doc(condominiumId)
      .collection('parcelReceptions')
      .doc(parcelId);

    // Verificar que el documento existe
    const parcelDoc = await parcelRef.get();
    if (!parcelDoc.exists) {
      logger.error(`El paquete con ID ${parcelId} no existe.`);
      throw new InternalServerErrorException(`El paquete con ID ${parcelId} no existe.`);
    }

    // Crear objeto con datos de actualización
    const updateData = {
      status,
      deliveryPerson,
      deliveredTo,
      deliveryNotes: deliveryNotes || "",
      deliveryDate,
      deliveryHour,
      dateDelivery: deliveryDate, // Para mantener compatibilidad con campo existente
      attachmentParcelDelivery: attachmentUrls,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    logger.log(`Actualizando paquete en Firestore. Path: clients/${clientId}/condominiums/${condominiumId}/parcelReceptions/${parcelId}`);
    
    // Actualizar el documento en Firestore
    await parcelRef.update(updateData);

    logger.log('Paquete actualizado correctamente en Firestore');
    return { 
      success: true, 
      parcelId, 
      status, 
      attachmentUrls 
    };
  } catch (error) {
    logger.error(`Error al actualizar el paquete: ${error.message}`, error.stack);
    throw new InternalServerErrorException('Error al actualizar el paquete.');
  }
}; 
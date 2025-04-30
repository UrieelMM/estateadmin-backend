import { InternalServerErrorException, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';
import { format } from 'date-fns';
import { ParcelDto } from 'src/dtos';

const logger = new Logger('ParcelReceptionCase');

export const ParcelReceptionCase = async (
  parcelDto: ParcelDto,
  files: any,
) => {
  logger.log(`Iniciando caso de uso ParcelReceptionCase con datos: ${JSON.stringify(parcelDto)}`);
  logger.log(`Archivos recibidos: ${files?.length || 0}`);
  
  const {
    email,
    receptor,
    recipientName,
    dateReception,
    hourReception,
    comments,
    clientId,
    condominiumId, // Usamos condominiumId como base para organizar las publicaciones
  } = parcelDto;

  if (!condominiumId || !clientId) {
    logger.error('No se ha proporcionado un condominiumId o clientId válido.');
    throw new InternalServerErrorException('No se ha proporcionado un condominiumId o clientId válido.');
  }

  const parcelReceptionId = uuidv4();
  const datePath = format(new Date(), 'yyyy-MM-dd');
  const bucket = admin.storage().bucket("administracioncondominio-93419.appspot.com");

  logger.log(`Preparando subida de archivos a bucket: ${bucket.name}`);
  
  // Ajustar la ruta de subida de archivos para incluir condominiumId
  const uploadPromises = files.map((file) => {
    const fileUploadPath = `clients/${clientId}/condominiums/${condominiumId}/parcelReceptions/${datePath}/${file.originalname}`;
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

  try {
    logger.log('Esperando a que se completen todas las subidas de archivos...');
    const attachmentUrls = await Promise.all(uploadPromises);
    logger.log(`Subidas completadas. URLs generadas: ${attachmentUrls.length}`);

    const parcelReceptionData = {
      email,
      parcelReceptionId,
      clientId,
      receptor,
      recipientName,
      dateReception,
      hourReception,
      comments,
      dateDelivery: "",
      attachmentParcelReception: attachmentUrls,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    logger.log(`Guardando en Firestore. Path: clients/${clientId}/condominiums/${condominiumId}/parcelReceptions/${parcelReceptionId}`);
    
    // Ajustar el camino en Firestore para incluir condominiumId
    await admin.firestore()
      .collection('clients')
      .doc(clientId)
      .collection('condominiums')
      .doc(condominiumId)
      .collection('parcelReceptions')
      .doc(parcelReceptionId)
      .set(parcelReceptionData);

    logger.log('Datos guardados correctamente en Firestore');
    return { parcelReceptionId, attachmentUrls };
  } catch (error) {
    logger.error(`Error al registrar el paquete: ${error.message}`, error.stack);
    throw new InternalServerErrorException('Error al registrar el paquete.');
  }
};

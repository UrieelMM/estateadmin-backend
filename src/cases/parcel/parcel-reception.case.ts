import { InternalServerErrorException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';
import { format } from 'date-fns';
import { ParcelDto } from 'src/dtos';

export const ParcelReceptionCase = async (
  parcelDto: ParcelDto,
  files: any,
) => {
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
    throw new InternalServerErrorException('No se ha proporcionado un condominiumId o clientId válido.');
  }

  const parcelReceptionId = uuidv4();
  const datePath = format(new Date(), 'yyyy-MM-dd');
  const bucket = admin.storage().bucket("administracioncondominio-93419.appspot.com");

  // Ajustar la ruta de subida de archivos para incluir condominiumId
  const uploadPromises = files.map((file) => {
    const fileUploadPath = `clients/${clientId}/condominiums/${condominiumId}/parcelReceptions/${datePath}/${file.originalname}`;
    const blob = bucket.file(fileUploadPath);

    return new Promise((resolve, reject) => {
      const blobStream = blob.createWriteStream({
        metadata: {
          contentType: file.mimetype,
        },
      });

      blobStream.on('error', reject);

      blobStream.on('finish', async () => {
        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${blob.name}`;
        resolve(publicUrl);
      });

      blobStream.end(file.buffer);
    });
  });

  try {
    const attachmentUrls = await Promise.all(uploadPromises);

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

    // Ajustar el camino en Firestore para incluir condominiumId
    await admin.firestore()
      .collection('clients')
      .doc(clientId)
      .collection('condominiums')
      .doc(condominiumId)
      .collection('parcelReceptions')
      .doc(parcelReceptionId)
      .set(parcelReceptionData);

    return { parcelReceptionId, attachmentUrls };
  } catch (error) {
    console.error('Error al registrar el paquete:', error);
    throw new InternalServerErrorException('Error al registrar el paquete.');
  }
};

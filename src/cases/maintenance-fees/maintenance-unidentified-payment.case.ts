// maintenance-unidentified-payment.case.ts
import { InternalServerErrorException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';
import { format } from 'date-fns';
import { CreateUnidentifiedPaymentDto } from 'src/dtos';

export const MaintenanceUnidentifiedPaymentCase = async (
  dto: CreateUnidentifiedPaymentDto,
  files: any,
) => {
  const {
    paymentId, // <-- Se recibe si se quiere actualizar
    email,
    numberCondominium,
    comments,
    clientId,
    condominiumId,
    amountPaid: amountPaidStr,
    amountPending: amountPendingStr,
    paymentType,
    paymentDate,
    financialAccountId,
    appliedToUser,
    appliedToCondomino, // Nuevo campo
    attachmentPayment: attachmentPaymentFromDto, // <-- Nuevo campo opcional
  } = dto;

  // Convertir montos a number
  const amountPaid = parseFloat(amountPaidStr || '0');
  const amountPending = parseFloat(amountPendingStr || '0');

  // Subir archivos (si existen)
  const datePath = format(new Date(), 'yyyy-MM-dd');
  const bucket = admin.storage().bucket('administracioncondominio-93419.appspot.com');
  const uploadPromises = files.map((file) => {
    const fileUploadPath = `clients/${clientId}/condominiums/${condominiumId}/payments/${datePath}/${file.originalname}`;
    const blob = bucket.file(fileUploadPath);
    return new Promise((resolve, reject) => {
      const blobStream = blob.createWriteStream({
        metadata: { contentType: file.mimetype },
      });
      blobStream.on('error', reject);
      blobStream.on('finish', async () => {
        try {
          // Hacemos público el archivo para que sea accesible desde el frontend
          await blob.setMetadata({
            acl: [{ entity: 'allUsers', role: 'READER' }],
          });
          const publicUrl = `https://storage.googleapis.com/${bucket.name}/${blob.name}`;
          resolve(publicUrl);
        } catch (err) {
          reject(err);
        }
      });
      blobStream.end(file.buffer);
    });
  });
  let attachmentUrls: string[] = [];
  if (files?.length) {
    try {
      attachmentUrls = (await Promise.all(uploadPromises)) as string[];
    } catch (error) {
      console.error('Error al subir archivos:', error);
      throw new InternalServerErrorException('Error al subir los archivos de comprobante.');
    }
  }
  const attachmentPayment = attachmentUrls.length > 0 ? attachmentUrls[0] : '';

  // Usar el valor recibido en el DTO si existe, sino el obtenido de la carga
  const finalAttachmentPayment = attachmentPaymentFromDto || attachmentPayment;

  // Si no se envía paymentId, generar uno nuevo
  const finalPaymentId = paymentId || uuidv4();
  const paymentGroupId = `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  const monthFormatted = paymentDate ? format(new Date(paymentDate), 'MM') : '';
  const yearMonth = paymentDate ? format(new Date(paymentDate), 'yyyy-MM') : '';

  // Construir el registro de pago no identificado
  const paymentRecord = {
    paymentId: finalPaymentId,
    email,
    numberCondominium,
    clientId,
    condominiumId,
    month: monthFormatted,
    yearMonth,
    comments,
    amountPaid,
    amountPending,
    attachmentPayment: finalAttachmentPayment, // Se copia el valor
    dateRegistered: admin.firestore.FieldValue.serverTimestamp(),
    paymentType: paymentType || '',
    paymentGroupId,
    paymentDate: paymentDate ? admin.firestore.Timestamp.fromDate(new Date(paymentDate)) : null,
    financialAccountId: financialAccountId || '',
    isUnidentifiedPayment: true,
    appliedToUser: false,
    appliedToCondomino: appliedToCondomino || '',
  };

  // Actualizar (o crear si no existe) el pago en la colección de pagos no identificados
  await admin
    .firestore()
    .collection('clients')
    .doc(clientId)
    .collection('condominiums')
    .doc(condominiumId)
    .collection('unidentifiedPayments')
    .doc(finalPaymentId)
    .set(paymentRecord, { merge: true }); // merge:true para actualizar campos existentes

  return { paymentId: finalPaymentId, attachmentUrls: finalAttachmentPayment };
};

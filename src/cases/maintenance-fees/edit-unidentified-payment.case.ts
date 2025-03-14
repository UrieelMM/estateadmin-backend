// src/use-cases/maintenance/edit-unidentified-payment.case.ts

import {
    InternalServerErrorException,
    NotFoundException,
  } from '@nestjs/common';
  import * as admin from 'firebase-admin';
  import { EditUnidentifiedPaymentDto } from 'src/dtos';
  
  export const EditUnidentifiedPaymentCase = async (
    dto: EditUnidentifiedPaymentDto,
  ) => {
    const { clientId, condominiumId, paymentId } = dto;
  
    try {
      // Referencia al documento en 'unidentifiedPayments'
      const paymentDocRef = admin
        .firestore()
        .collection('clients')
        .doc(clientId)
        .collection('condominiums')
        .doc(condominiumId)
        .collection('unidentifiedPayments')
        .doc(paymentId);
  
      // Verificamos si el documento existe
      const docSnapshot = await paymentDocRef.get();
      if (!docSnapshot.exists) {
        throw new NotFoundException(
          `No existe un pago no identificado con el ID: ${paymentId}`,
        );
      }
  
      // Actualizamos los campos requeridos
      await paymentDocRef.set(
        {
          amountPaid: 0,
          appliedToUser: true,
          dateToApplied: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  
      return {
        paymentId,
        updated: true,
      };
    } catch (error) {
      // Regresamos un error interno si falla cualquier parte del proceso
      console.error('[EditUnidentifiedPaymentCase] Error:', error);
      throw new InternalServerErrorException(
        error.message || 'Error al editar el pago no identificado.',
      );
    }
  };
  
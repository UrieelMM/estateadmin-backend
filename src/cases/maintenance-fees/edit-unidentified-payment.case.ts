import {
  InternalServerErrorException,
  NotFoundException,
  HttpException,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { EditUnidentifiedPaymentDto } from 'src/dtos';
import {
  resolveTowerSnapshot,
  sanitizeTowerSnapshot,
} from 'src/utils/tower-snapshot';

const resolveUserForAppliedPayment = async (params: {
  usersRef: FirebaseFirestore.CollectionReference;
  userId?: string;
  appliedToCondomino?: string;
  fallbackNumberCondominium?: string;
}): Promise<{ userId: string; tower?: string } | null> => {
  const directUserId = String(params.userId || '').trim();
  const rawTarget = String(params.appliedToCondomino || '').trim();
  const fallbackNumber = String(params.fallbackNumberCondominium || '').trim();

  if (directUserId) {
    const byUidDoc = await params.usersRef.doc(directUserId).get();
    if (!byUidDoc.exists) {
      throw new NotFoundException(
        `No existe el usuario objetivo con userId: ${directUserId}`,
      );
    }

    const userData = byUidDoc.data() || {};
    return {
      userId: byUidDoc.id,
      tower: userData.tower,
    };
  }

  if (rawTarget) {
    const byUidDoc = await params.usersRef.doc(rawTarget).get();
    if (byUidDoc.exists) {
      const userData = byUidDoc.data() || {};
      return {
        userId: byUidDoc.id,
        tower: userData.tower,
      };
    }

    const byNumber = await params.usersRef.where('number', '==', rawTarget).limit(2).get();
    if (!byNumber.empty) {
      if (byNumber.size > 1) {
        throw new InternalServerErrorException(
          'No se puede aplicar el pago: número de condómino ambiguo.',
        );
      }
      const userDoc = byNumber.docs[0];
      const userData = userDoc.data() || {};
      return {
        userId: userDoc.id,
        tower: userData.tower,
      };
    }
  }

  if (fallbackNumber) {
    const byFallbackNumber = await params.usersRef
      .where('number', '==', fallbackNumber)
      .limit(2)
      .get();
    if (!byFallbackNumber.empty) {
      if (byFallbackNumber.size > 1) {
        throw new InternalServerErrorException(
          'No se puede aplicar el pago: número de condómino ambiguo.',
        );
      }
      const userDoc = byFallbackNumber.docs[0];
      const userData = userDoc.data() || {};
      return {
        userId: userDoc.id,
        tower: userData.tower,
      };
    }
  }

  return null;
};

export const EditUnidentifiedPaymentCase = async (
  dto: EditUnidentifiedPaymentDto,
) => {
  const {
    clientId,
    condominiumId,
    paymentId,
    userId,
    appliedToCondomino,
    appliedTowerSnapshot,
  } = dto;

  try {
    const condominiumRef = admin
      .firestore()
      .collection('clients')
      .doc(clientId)
      .collection('condominiums')
      .doc(condominiumId);

    const condominiumDoc = await condominiumRef.get();
    if (!condominiumDoc.exists) {
      throw new NotFoundException(
        'Condominio inválido para el clientId proporcionado.',
      );
    }

    const paymentDocRef = condominiumRef
      .collection('unidentifiedPayments')
      .doc(paymentId);

    const docSnapshot = await paymentDocRef.get();
    if (!docSnapshot.exists) {
      throw new NotFoundException(
        `No existe un pago no identificado con el ID: ${paymentId}`,
      );
    }

    const paymentData = docSnapshot.data() || {};
    const usersRef = condominiumRef.collection('users');
    const resolvedUser = await resolveUserForAppliedPayment({
      usersRef,
      userId,
      appliedToCondomino,
      fallbackNumberCondominium: String(paymentData.numberCondominium || ''),
    });

    const canonicalTower = sanitizeTowerSnapshot(resolvedUser?.tower);
    const inputTower = sanitizeTowerSnapshot(appliedTowerSnapshot);
    const appliedTowerSnapshotFinal =
      canonicalTower && inputTower && canonicalTower !== inputTower
        ? canonicalTower
        : resolveTowerSnapshot(inputTower, canonicalTower);

    await paymentDocRef.set(
      {
        amountPaid: 0,
        appliedToUser: true,
        appliedToCondomino: resolvedUser?.userId || String(appliedToCondomino || '').trim(),
        appliedTowerSnapshot: appliedTowerSnapshotFinal,
        towerSnapshot: appliedTowerSnapshotFinal,
        appliedAt: admin.firestore.FieldValue.serverTimestamp(),
        dateToApplied: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      paymentId,
      updated: true,
      appliedToCondomino: resolvedUser?.userId || String(appliedToCondomino || '').trim(),
      appliedTowerSnapshot: appliedTowerSnapshotFinal,
    };
  } catch (error) {
    if (error instanceof HttpException) {
      throw error;
    }
    console.error('[EditUnidentifiedPaymentCase] Error:', error);
    throw new InternalServerErrorException(
      error.message || 'Error al editar el pago no identificado.',
    );
  }
};

import { InternalServerErrorException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';
import { format } from 'date-fns';
import { CreateUnidentifiedPaymentDto } from 'src/dtos';
import {
  resolveTowerSnapshot,
  sanitizeTowerSnapshot,
} from 'src/utils/tower-snapshot';

type UserLookupResult = {
  userId: string;
  userData: FirebaseFirestore.DocumentData;
};

const getUniqueUserByField = async (
  usersRef: FirebaseFirestore.CollectionReference,
  field: 'number' | 'email',
  value: string,
): Promise<UserLookupResult | null> => {
  const snapshot = await usersRef.where(field, '==', value).limit(2).get();
  if (snapshot.empty) {
    return null;
  }

  if (snapshot.size > 1) {
    throw new InternalServerErrorException(
      `No se puede resolver el condómino por ${field}: coincidencias múltiples.`,
    );
  }

  const userDoc = snapshot.docs[0];
  return {
    userId: userDoc.id,
    userData: userDoc.data() || {},
  };
};

const resolveAppliedUser = async (params: {
  usersRef: FirebaseFirestore.CollectionReference;
  appliedToCondomino?: string;
  numberCondominium?: string;
  email?: string;
}): Promise<UserLookupResult | null> => {
  const normalizedAppliedToCondomino = String(
    params.appliedToCondomino || '',
  ).trim();
  const normalizedNumber = String(params.numberCondominium || '').trim();
  const normalizedEmail = String(params.email || '')
    .trim()
    .toLowerCase();

  if (normalizedAppliedToCondomino) {
    const byUidDoc = await params.usersRef.doc(normalizedAppliedToCondomino).get();
    if (byUidDoc.exists) {
      return {
        userId: byUidDoc.id,
        userData: byUidDoc.data() || {},
      };
    }

    const byNumber = await getUniqueUserByField(
      params.usersRef,
      'number',
      normalizedAppliedToCondomino,
    );
    if (byNumber) {
      return byNumber;
    }

    const byEmail = await getUniqueUserByField(
      params.usersRef,
      'email',
      normalizedAppliedToCondomino.toLowerCase(),
    );
    if (byEmail) {
      return byEmail;
    }
  }

  if (normalizedNumber) {
    const byNumber = await getUniqueUserByField(
      params.usersRef,
      'number',
      normalizedNumber,
    );
    if (byNumber) {
      return byNumber;
    }
  }

  if (normalizedEmail) {
    const byEmail = await getUniqueUserByField(
      params.usersRef,
      'email',
      normalizedEmail,
    );
    if (byEmail) {
      return byEmail;
    }
  }

  return null;
};

export const MaintenanceUnidentifiedPaymentCase = async (
  dto: CreateUnidentifiedPaymentDto,
  files: any,
) => {
  const {
    paymentId,
    email,
    numberCondominium,
    comments,
    clientId,
    condominiumId,
    amountPaid: amountPaidStr,
    amountPending: amountPendingStr,
    paymentType,
    paymentDate,
    paymentReference,
    financialAccountId,
    appliedToUser,
    appliedToCondomino,
    attachmentPayment: attachmentPaymentFromDto,
    towerSnapshot,
  } = dto;

  const amountPaid = parseFloat(amountPaidStr || '0');
  const amountPending = parseFloat(amountPendingStr || '0');

  const firestore = admin.firestore();
  const condominiumRef = firestore
    .collection('clients')
    .doc(clientId)
    .collection('condominiums')
    .doc(condominiumId);

  const condominiumDoc = await condominiumRef.get();
  if (!condominiumDoc.exists) {
    throw new InternalServerErrorException(
      'Condominio inválido para el clientId proporcionado.',
    );
  }

  const usersRef = condominiumRef.collection('users');

  const appliedToUserFlag =
    appliedToUser === true || String(appliedToUser) === 'true';
  let appliedUser: UserLookupResult | null = null;

  if (appliedToUserFlag) {
    appliedUser = await resolveAppliedUser({
      usersRef,
      appliedToCondomino,
      numberCondominium,
      email,
    });

    if (!appliedUser) {
      throw new InternalServerErrorException(
        'No se encontró el condómino objetivo para aplicar el pago no identificado.',
      );
    }
  }

  const datePath = format(new Date(), 'yyyy-MM-dd');
  const bucket = admin
    .storage()
    .bucket('administracioncondominio-93419.appspot.com');

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
      throw new InternalServerErrorException(
        'Error al subir los archivos de comprobante.',
      );
    }
  }

  const attachmentPayment = attachmentUrls.length > 0 ? attachmentUrls[0] : '';
  const finalAttachmentPayment = attachmentPaymentFromDto || attachmentPayment;

  const finalPaymentId = paymentId || uuidv4();
  const paymentGroupId =
    dto.paymentGroupId ||
    `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
  const monthFormatted = paymentDate ? format(new Date(paymentDate), 'MM') : '';
  const yearMonth = paymentDate ? format(new Date(paymentDate), 'yyyy-MM') : '';

  const inputTowerSnapshot = sanitizeTowerSnapshot(towerSnapshot);
  const canonicalUserTower = sanitizeTowerSnapshot(appliedUser?.userData?.tower);

  const towerSnapshotFinal = appliedToUserFlag
    ? canonicalUserTower &&
      inputTowerSnapshot &&
      inputTowerSnapshot !== canonicalUserTower
      ? canonicalUserTower
      : resolveTowerSnapshot(inputTowerSnapshot, canonicalUserTower)
    : '';

  const appliedToCondominoFinal = appliedToUserFlag
    ? appliedUser?.userId || ''
    : String(appliedToCondomino || '').trim();

  const paymentRecord: Record<string, any> = {
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
    attachmentPayment: finalAttachmentPayment,
    dateRegistered: admin.firestore.FieldValue.serverTimestamp(),
    paymentType: paymentType || '',
    paymentGroupId,
    paymentDate: paymentDate
      ? admin.firestore.Timestamp.fromDate(new Date(paymentDate))
      : null,
    paymentReference: paymentReference || '',
    financialAccountId: financialAccountId || '',
    isUnidentifiedPayment: true,
    appliedToUser: appliedToUserFlag,
    appliedToCondomino: appliedToCondominoFinal,
    towerSnapshot: towerSnapshotFinal,
    paymentAmountReference: amountPaid,
  };

  if (appliedToUserFlag) {
    paymentRecord.appliedAt = admin.firestore.FieldValue.serverTimestamp();
    paymentRecord.appliedTowerSnapshot = towerSnapshotFinal;
  }

  await condominiumRef
    .collection('unidentifiedPayments')
    .doc(finalPaymentId)
    .set(paymentRecord, { merge: true });

  return {
    paymentId: finalPaymentId,
    attachmentUrls: finalAttachmentPayment,
    towerSnapshot: towerSnapshotFinal,
    appliedToUser: appliedToUserFlag,
  };
};

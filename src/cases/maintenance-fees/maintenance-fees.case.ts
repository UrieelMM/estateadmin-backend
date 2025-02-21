import { InternalServerErrorException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';
import { format } from 'date-fns';
import { MaintenanceFeesDto } from 'src/dtos';

/**
 * Reglas:
 * - Pagos parciales: se descuenta charge.amount con amountPaid.
 * - Sobrepago: el excedente se guarda en creditBalance en el pago y, a partir de ahora,
 *   NO se aplica automáticamente al siguiente cargo; se registra para uso manual.
 * - Se permite que un mismo pago se distribuya a varios cargos (campo chargeAssignments).
 * - startAt y dueDate se guardan como string.
 * - Si charge.amount llega a 0 se marca como paid:true.
 * 
 * Nuevo caso: si el usuario decide pagar un cargo usando únicamente su saldo a favor
 * (por ejemplo, amountPaid = 0, pero con suficiente crédito para cubrir el cargo),
 * se permitirá guardar el pago y se aplicará el crédito disponible para completar el cargo.
 */
export const MaintenancePaymentCase = async (
  maintenancePaymentDto: MaintenanceFeesDto,
  files: Express.Multer.File[],
) => {
  const {
    email,
    numberCondominium,
    month,
    comments,
    clientId,
    condominiumId,
    // Monto de pago parcial
    amountPaid: amountPaidStr,
    amountPending: amountPendingStr,
    // Si es un cargo nuevo
    cargoTotal: cargoTotalStr,
    // Si se paga un cargo existente
    chargeId,
    // Fechas como string
    startAtStr,
    dueDateStr,
    // Pago a múltiples cargos (JSON)
    chargeAssignments, // opcional
    // Indicador de uso de crédito
    useCreditBalance,
    // Tipo de pago: Transferencia, Efectivo, Tarjeta.
    paymentType,
    // Agrupación de pagos
    paymentGroupId,
  } = maintenancePaymentDto;

  // Convertir useCreditBalance a boolean
  const applyCredit =
    typeof useCreditBalance === 'string'
      ? useCreditBalance === 'true'
      : !!useCreditBalance;

  if (!clientId || !condominiumId) {
    throw new InternalServerErrorException(
      'No se ha proporcionado un condominiumId o clientId válido.'
    );
  }

  // Convertir montos a number
  const amountPaid = parseFloat(amountPaidStr || '0');
  const amountPending = parseFloat(amountPendingStr || '0');
  const cargoTotal = parseFloat(cargoTotalStr || '0');

  // 1. Buscar al usuario por su número
  const userSnap = await admin
    .firestore()
    .collection('clients')
    .doc(clientId)
    .collection('condominiums')
    .doc(condominiumId)
    .collection('users')
    .where('number', '==', numberCondominium)
    .get();

  if (userSnap.empty) {
    throw new InternalServerErrorException(
      `No se encontró un usuario con el número de condómino: ${numberCondominium}.`
    );
  }
  const userDoc = userSnap.docs[0];
  const userId = userDoc.id;
  const userData = userDoc.data();
  const phoneNumber = userData?.phone || null;
  const invoiceRequired = userData?.invoiceRequired ?? false;
  const currentTotalCredit = parseFloat(userData.totalCreditBalance || '0');

  // 2. Subir archivos (si existen)
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
      blobStream.on('finish', () => {
        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${blob.name}`;
        resolve(publicUrl);
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

  // 3. PROCESO MULTI-CARGO
  if (chargeAssignments) {
    let assignments: { chargeId: string; amount: number; dueDate?: number }[] = [];
    try {
      assignments = JSON.parse(chargeAssignments);
    } catch (error) {
      throw new InternalServerErrorException('chargeAssignments no es un JSON válido.');
    }
    const totalAssigned = assignments.reduce((sum, curr) => sum + curr.amount, 0);
    // Si no se usa crédito, se exige que totalAssigned === amountPaid.
    // Si se usa crédito, permitimos que totalAssigned > amountPaid.
    if (!applyCredit && totalAssigned !== amountPaid) {
      throw new InternalServerErrorException(
        'El monto abonado debe coincidir exactamente con la suma de los cargos asignados.'
      );
    }
    // En multi-cargo, si se usa crédito, se calcula creditUsed como (totalAssigned - amountPaid)
    const creditUsed = applyCredit && totalAssigned > amountPaid ? totalAssigned - amountPaid : 0;
    let totalLeftover = 0;
    for (const assignment of assignments) {
      const assignmentChargeRef = admin
        .firestore()
        .collection('clients')
        .doc(clientId)
        .collection('condominiums')
        .doc(condominiumId)
        .collection('users')
        .doc(userId)
        .collection('charges')
        .doc(assignment.chargeId);
      const chargeSnap = await assignmentChargeRef.get();
      if (!chargeSnap.exists) {
        throw new InternalServerErrorException(`El cargo con id ${assignment.chargeId} no existe.`);
      }
      const chargeData = chargeSnap.data() || {};
      const currentRemaining = chargeData.amount || 0;
      let assignedAmount = assignment.amount;
      let leftoverForThisCharge = 0;
      if (assignedAmount > currentRemaining) {
        leftoverForThisCharge = assignedAmount - currentRemaining;
        assignedAmount = currentRemaining;
      }
      const newRemaining = currentRemaining - assignedAmount;
      const isPaid = newRemaining <= 0;
      await assignmentChargeRef.update({ amount: newRemaining, paid: isPaid });
      const paymentId = uuidv4();
      const paymentRecord = {
        paymentId,
        email,
        numberCondominium,
        clientId,
        condominiumId,
        month: month || '',
        comments,
        amountPaid: assignedAmount,
        amountPending,
        attachmentPayment: attachmentUrls,
        dateRegistered: admin.firestore.FieldValue.serverTimestamp(),
        phone: phoneNumber,
        invoiceRequired,
        // Se guarda el crédito sobrante generado en este cargo, si existe.
        creditBalance: leftoverForThisCharge > 0 ? leftoverForThisCharge : 0,
        paymentType: paymentType || '',
        paymentGroupId: paymentGroupId || '',
        creditUsed: 0,
      };
      await assignmentChargeRef.collection('payments').doc(paymentId).set(paymentRecord);
      totalLeftover += leftoverForThisCharge;
    }
    // Actualizar totalCreditBalance: se resta el crédito usado y se suma el sobrante.
    const userRef = admin
      .firestore()
      .collection('clients')
      .doc(clientId)
      .collection('condominiums')
      .doc(condominiumId)
      .collection('users')
      .doc(userId);
    const newUserTotalCredit = currentTotalCredit - creditUsed + totalLeftover;
    const newTotalCredit = Math.round(newUserTotalCredit * 100) / 100;
    await userRef.update({ totalCreditBalance: newTotalCredit });
    return { overallCreditBalance: 0, attachmentUrls };
  }
  // 4. PROCESO ÚNICO (sin chargeAssignments)
  else {
    const userRef = admin
      .firestore()
      .collection('clients')
      .doc(clientId)
      .collection('condominiums')
      .doc(condominiumId)
      .collection('users')
      .doc(userId);
    let finalChargeId = chargeId ? chargeId : (month ? month : uuidv4());
    const chargeRef = admin
      .firestore()
      .collection('clients')
      .doc(clientId)
      .collection('condominiums')
      .doc(condominiumId)
      .collection('users')
      .doc(userId)
      .collection('charges')
      .doc(finalChargeId);
    let remainingAmount = 0;
    if (!(await chargeRef.get()).exists) {
      if (!cargoTotal || cargoTotal <= 0) {
        throw new InternalServerErrorException('No se especificó un cargoTotal válido al crear el cargo.');
      }
      remainingAmount = cargoTotal;
      await chargeRef.set({
        concept: 'Cuota de mantenimiento',
        amount: remainingAmount,
        email,
        numberCondominium,
        phone: phoneNumber,
        month: month ?? '',
        comments,
        dateRegistered: admin.firestore.FieldValue.serverTimestamp(),
        paid: false,
        invoiceRequired,
        startAt: startAtStr || '',
        dueDate: dueDateStr || '',
      });
    } else {
      const chargeSnap = await chargeRef.get();
      const chargeData = chargeSnap.data() || {};
      remainingAmount = chargeData.amount || 0;
      await chargeRef.update({
        phone: phoneNumber,
        comments,
        invoiceRequired,
        ...(startAtStr ? { startAt: startAtStr } : {}),
        ...(dueDateStr ? { dueDate: dueDateStr } : {}),
      });
    }
    // --- Cálculo del pago único ---
    let creditToApply = 0;
    if (applyCredit && currentTotalCredit > 0 && amountPaid < remainingAmount) {
      creditToApply = Math.min(currentTotalCredit, remainingAmount - amountPaid);
    }
    const effectivePayment = amountPaid + creditToApply;
    const creditUsed = creditToApply;
    let leftover = 0;
    if (effectivePayment > remainingAmount) {
      leftover = Math.round((effectivePayment - remainingAmount) * 100) / 100;
    }
    const newRemaining = effectivePayment >= remainingAmount ? 0 : remainingAmount - effectivePayment;
    const isPaid = newRemaining === 0;
    const paymentId = uuidv4();
    const paymentData = {
      paymentId,
      email,
      numberCondominium,
      clientId,
      condominiumId,
      month: month ?? '',
      comments,
      amountPaid: effectivePayment,
      amountPending,
      attachmentPayment: attachmentUrls,
      dateRegistered: admin.firestore.FieldValue.serverTimestamp(),
      phone: phoneNumber,
      invoiceRequired,
      creditBalance: leftover > 0 ? leftover : 0,
      creditUsed,
      paymentType: paymentType || '',
      paymentGroupId: paymentGroupId || '',
    };
    await chargeRef.collection('payments').doc(paymentId).set(paymentData);
    await chargeRef.update({ amount: newRemaining, paid: isPaid });
    // Actualizar el totalCreditBalance del usuario mediante transacción:
    await admin.firestore().runTransaction(async (transaction) => {
      const userDocRef = userRef;
      const userDoc = await transaction.get(userDocRef);
      const currentCredit = parseFloat(userDoc.data()?.totalCreditBalance || '0');
      const newCredit = currentCredit - creditUsed + leftover;
      transaction.update(userDocRef, { totalCreditBalance: Math.round(newCredit * 100) / 100 });
    });
    return {
      paymentId,
      attachmentUrls,
      leftoverApplied: leftover,
    };
  }
};

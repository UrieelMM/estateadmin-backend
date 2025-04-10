import { InternalServerErrorException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';
import { format } from 'date-fns';
import { MaintenanceFeesDto } from 'src/dtos';
import { UploadedFiles } from 'src/interfaces';

/**
 * Reglas:
 * - Pagos parciales: se descuenta charge.amount con amountPaid.
 * - Sobrepago: el excedente se guarda en creditBalance en el pago.
 * - Un mismo pago se puede repartir a varios cargos (campo chargeAssignments).
 * - startAt, dueDate y paymentDate se guardan como string.
 * - Si charge.amount llega a 0 se marca como paid:true.
 * - Nuevo: si amountPaid=0 y el usuario tiene suficiente saldo, se permite pagar con saldo a favor.
 *
 * CAMBIO: Se añade paymentDate (ahora se espera un ISO string) y financialAccountId en cada pago.
 */
export const MaintenancePaymentCase = async (
  maintenancePaymentDto: MaintenanceFeesDto,
  files: any,
) => {
  // Si se recibe el flag de pago no identificado, este endpoint no lo procesa
  if (
    String(maintenancePaymentDto.isUnidentifiedPayment) === 'true' ||
    maintenancePaymentDto.isUnidentifiedPayment === true
  ) {
    throw new InternalServerErrorException(
      'Este endpoint es solo para pagos identificados.',
    );
  }

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
    // NUEVO: Fecha de pago y cuenta seleccionada
    // Ahora se espera un ISO string con la fecha de pago
    paymentDate,
    financialAccountId,
  } = maintenancePaymentDto;

  // NUEVO: Obtener el arreglo de startAt(s) enviado desde el componente (para multipago)
  const startAtsArray = maintenancePaymentDto.startAts
    ? JSON.parse(maintenancePaymentDto.startAts)
    : [];

  // Convertir useCreditBalance a boolean
  const applyCredit =
    typeof useCreditBalance === 'string'
      ? useCreditBalance === 'true'
      : !!useCreditBalance;

  if (!clientId || !condominiumId) {
    throw new InternalServerErrorException(
      'No se ha proporcionado un condominiumId o clientId válido.',
    );
  }

  // Convertir montos a number
  const amountPaid = parseFloat(amountPaidStr || '0');
  const amountPending = parseFloat(amountPendingStr || '0');
  const cargoTotal = parseFloat(maintenancePaymentDto.cargoTotal || '0');

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
      `No se encontró un usuario con el número de condómino: ${numberCondominium}.`,
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
      throw new InternalServerErrorException(
        'Error al subir los archivos de comprobante.',
      );
    }
  }
  // Si no se sube un archivo, se usa el valor enviado en maintenancePaymentDto.attachmentPayment
  const attachmentPayment =
    attachmentUrls.length > 0
      ? attachmentUrls[0]
      : maintenancePaymentDto.attachmentPayment || '';
  console.log('attachmentPayment', attachmentPayment);

  // Determinar el mes formateado a partir de paymentDate (ej: "01", "02", etc.)
  const monthFormatted = paymentDate ? format(new Date(paymentDate), 'MM') : '';
  // Calcular el año-mes a partir de paymentDate (ej: "2025-03")
  const yearMonth = paymentDate ? format(new Date(paymentDate), 'yyyy-MM') : '';

  // Generar un timestamp único para los registros
  const currentTimestamp = admin.firestore.Timestamp.now();

  // 3. PROCESO MULTI-CARGO
  if (chargeAssignments) {
    let assignments: { chargeId: string; amount: number; dueDate?: number }[] =
      [];
    try {
      assignments = JSON.parse(chargeAssignments);
    } catch (error) {
      throw new InternalServerErrorException(
        'chargeAssignments no es un JSON válido.',
      );
    }

    // Generar folio único para todos los pagos del multipago
    const folio = `EA-${Math.floor(Math.random() * 1e12)
      .toString()
      .padStart(12, '0')}`;

    const totalAssigned = assignments.reduce(
      (sum, curr) => sum + curr.amount,
      0,
    );
    if (!applyCredit && totalAssigned !== amountPaid) {
      throw new InternalServerErrorException(
        'El monto abonado debe coincidir exactamente con la suma de los cargos asignados.',
      );
    }

    const creditUsed =
      applyCredit && totalAssigned > amountPaid
        ? totalAssigned - amountPaid
        : 0;

    let totalLeftover = 0;
    const paymentsArray: any[] = [];
    let index = 0;
    // Por cada asignación se procesa el cargo correspondiente
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
        throw new InternalServerErrorException(
          `El cargo con id ${assignment.chargeId} no existe.`,
        );
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

      // Procesar el concepto
      const conceptProcessed = Array.isArray(chargeData.concept)
        ? chargeData.concept.join(', ')
        : chargeData.concept || 'Desconocido';

      const individualPaymentId = uuidv4();
      const paymentRecord = {
        paymentId: individualPaymentId,
        email,
        numberCondominium,
        clientId,
        condominiumId,
        userId,
        chargeUID: assignment.chargeId,
        month: monthFormatted,
        yearMonth,
        comments,
        amountPaid: assignedAmount,
        amountPending,
        attachmentPayment: attachmentPayment,
        dateRegistered: currentTimestamp,
        phone: phoneNumber,
        invoiceRequired,
        creditBalance: leftoverForThisCharge > 0 ? leftoverForThisCharge : 0,
        paymentType: paymentType || '',
        paymentGroupId: paymentGroupId || '',
        creditUsed: creditUsed,
        paymentDate: paymentDate
          ? admin.firestore.Timestamp.fromDate(new Date(paymentDate))
          : null,
        financialAccountId: financialAccountId || '',
        concept: conceptProcessed,
        // NUEVO: Enviar el startAt correspondiente del arreglo (según el orden de asignaciones)
        startAt: startAtsArray[index] || '',
        // NUEVO: Agregar folio
        folio: folio,
      };
      console.log('individual paymentRecord', paymentRecord);
      await assignmentChargeRef
        .collection('payments')
        .doc(individualPaymentId)
        .set(paymentRecord);
      paymentsArray.push(paymentRecord);
      totalLeftover += leftoverForThisCharge;
      index++;
    }

    const aggregatedAmountPaid = paymentsArray.reduce(
      (sum, p) => sum + Number(p.amountPaid || 0),
      0,
    );
    const aggregatedCreditBalance = paymentsArray.reduce(
      (sum, p) => sum + Number(p.creditBalance || 0),
      0,
    );

    // Consolidar los conceptos de los pagos individuales (valores únicos)
    const aggregatedConcepts = Array.from(
      new Set(paymentsArray.map((p) => p.concept).filter((c) => c)),
    );

    // Crear un único registro consolidado para paymentsToSendEmail
    const aggregatedPaymentId = uuidv4();
    const aggregatedPaymentRecord = {
      paymentId: aggregatedPaymentId,
      email,
      numberCondominium,
      clientId,
      condominiumId,
      userId,
      chargeUID: chargeId || '', // Se puede conservar el chargeUID original o dejarlo vacío
      month: monthFormatted,
      yearMonth,
      comments,
      amountPaid: aggregatedAmountPaid,
      amountPending,
      attachmentPayment: attachmentPayment,
      dateRegistered: currentTimestamp,
      phone: phoneNumber,
      invoiceRequired,
      creditBalance: aggregatedCreditBalance,
      creditUsed: creditUsed,
      paymentType: paymentType || '',
      paymentGroupId: paymentGroupId || '',
      paymentDate: paymentDate
        ? admin.firestore.Timestamp.fromDate(new Date(paymentDate))
        : null,
      financialAccountId: financialAccountId || '',
      payments: paymentsArray, // Array con los registros individuales
      concept: aggregatedConcepts.join(', ') || 'Desconocido',
      // NUEVO: En el registro consolidado, se unen todos los startAt enviados (separados por comas)
      startAt: startAtsArray.length ? startAtsArray.join(', ') : '',
      // NUEVO: Agregar folio
      folio: folio,
      // NUEVO: Agregar el valor del cargo original
      chargeValue: assignments.reduce((sum, curr) => {
        const originalChargeAmount = paymentsArray.find(p => p.chargeUID === curr.chargeId)?.amountPaid || 0;
        return sum + originalChargeAmount;
      }, 0),
    };

    await admin
      .firestore()
      .collection('clients')
      .doc(clientId)
      .collection('condominiums')
      .doc(condominiumId)
      .collection('paymentsToSendEmail')
      .doc(aggregatedPaymentId)
      .set(aggregatedPaymentRecord);

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

    return {
      overallCreditBalance: newTotalCredit,
      attachmentUrls: attachmentPayment,
    };
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

    let finalChargeId = chargeId ? chargeId : month ? month : uuidv4();
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
    const existingCharge = await chargeRef.get();

    let chargeConcept = 'Cuota de mantenimiento';
    if (!existingCharge.exists) {
      if (!cargoTotal || cargoTotal <= 0) {
        throw new InternalServerErrorException(
          'No se especificó un cargoTotal válido al crear el cargo.',
        );
      }
      remainingAmount = cargoTotal;
      await chargeRef.set({
        concept: chargeConcept,
        amount: remainingAmount,
        email,
        numberCondominium,
        phone: phoneNumber,
        month: monthFormatted,
        yearMonth: yearMonth,
        comments,
        dateRegistered: currentTimestamp,
        paid: false,
        invoiceRequired,
        // NUEVO: Procesar startAt usando startAtStr o, si no, la propiedad enviada desde el componente
        startAt: startAtStr || maintenancePaymentDto.startAt || '',
        dueDate: dueDateStr || '',
      });
    } else {
      const chargeData = existingCharge.data() || {};
      remainingAmount = chargeData.amount || 0;
      chargeConcept = chargeData.concept;
      await chargeRef.update({
        phone: phoneNumber,
        comments,
        invoiceRequired,
        ...(startAtStr || maintenancePaymentDto.startAt
          ? { startAt: startAtStr || maintenancePaymentDto.startAt }
          : {}),
        ...(dueDateStr ? { dueDate: dueDateStr } : {}),
      });
    }
    const conceptProcessed = Array.isArray(chargeConcept)
      ? chargeConcept.join(', ')
      : chargeConcept || 'Desconocido';

    let creditToApply = 0;
    if (applyCredit && currentTotalCredit > 0 && amountPaid < remainingAmount) {
      creditToApply = Math.min(
        currentTotalCredit,
        remainingAmount - amountPaid,
      );
    }

    const effectivePayment = amountPaid + creditToApply;
    const creditUsed = creditToApply;
    let leftover = 0;
    if (effectivePayment > remainingAmount) {
      leftover = Math.round((effectivePayment - remainingAmount) * 100) / 100;
    }

    const newRemaining =
      effectivePayment >= remainingAmount
        ? 0
        : remainingAmount - effectivePayment;
    const isPaid = newRemaining === 0;

    const paymentId = uuidv4();
    // Generar folio para pago único
    const folio = `EA-${Math.floor(Math.random() * 1e12)
      .toString()
      .padStart(12, '0')}`;
    const paymentData = {
      paymentId,
      email,
      numberCondominium,
      clientId,
      condominiumId,
      userId,
      chargeUID: chargeId || '',
      month: monthFormatted,
      yearMonth: yearMonth,
      comments,
      amountPaid: effectivePayment,
      amountPending,
      attachmentPayment: attachmentPayment,
      dateRegistered: currentTimestamp,
      phone: phoneNumber,
      invoiceRequired,
      creditBalance: leftover > 0 ? leftover : 0,
      creditUsed,
      paymentType: paymentType || '',
      paymentGroupId: paymentGroupId || '',
      paymentDate: paymentDate
        ? admin.firestore.Timestamp.fromDate(new Date(paymentDate))
        : null,
      financialAccountId: financialAccountId || '',
      concept: conceptProcessed,
      // NUEVO: Procesar startAt en pago único
      startAt: startAtStr || maintenancePaymentDto.startAt || '',
      // NUEVO: Agregar folio
      folio: folio,
      // NUEVO: Agregar el valor del cargo original
      chargeValue: remainingAmount,
    };

    await chargeRef.collection('payments').doc(paymentId).set(paymentData);
    // Insertar un único registro en paymentsToSendEmail
    await admin
      .firestore()
      .collection('clients')
      .doc(clientId)
      .collection('condominiums')
      .doc(condominiumId)
      .collection('paymentsToSendEmail')
      .doc(paymentId)
      .set(paymentData);

    await chargeRef.update({ amount: newRemaining, paid: isPaid });

    await admin.firestore().runTransaction(async (transaction) => {
      const userDocRef = userRef;
      const userDoc = await transaction.get(userDocRef);
      const currentCredit = parseFloat(
        userDoc.data()?.totalCreditBalance || '0',
      );
      const newCredit = currentCredit - creditUsed + leftover;
      transaction.update(userDocRef, {
        totalCreditBalance: Math.round(newCredit * 100) / 100,
      });
    });

    return {
      paymentId,
      attachmentUrls: attachmentPayment,
      leftoverApplied: leftover,
    };
  }
};

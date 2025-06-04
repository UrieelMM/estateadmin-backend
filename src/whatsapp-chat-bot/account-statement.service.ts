import { Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import axios from 'axios';

export interface ChargeData {
  id: string;
  amount: number;
  chargeAmountReference: number;
  chargeId: string;
  concept: string;
  dueDate: string;
  email: string;
  generatedAt: admin.firestore.Timestamp;
  name: string;
  paid: boolean;
  referenceAmount: number;
  startAt: string;
}

export interface PaymentData {
  id: string;
  amountPaid: number;
  amountPending: number;
  attachmentPayment: string;
  chargeUID: string;
  concept: string;
  creditBalance: number;
  creditUsed: number;
  dateRegistered: admin.firestore.Timestamp;
  folio: string;
  month: string;
  paymentDate: admin.firestore.Timestamp;
  paymentType: string;
  yearMonth: string;
}

export interface ProcessedAccountData {
  charges: ChargeData[];
  payments: PaymentData[];
  summary: {
    totalCharges: number;
    totalPaid: number;
    totalBalance: number;
    totalCreditBalance: number;
  };
}

@Injectable()
export class AccountStatementService {
  private readonly logger = new Logger(AccountStatementService.name);
  private firestore: admin.firestore.Firestore;

  constructor() {
    this.firestore = admin.firestore();
  }

  /**
   * Obtiene todos los cargos y pagos del usuario para generar el estado de cuenta
   */
  async getAccountData(
    clientId: string,
    condominiumId: string,
    userId: string,
  ): Promise<ProcessedAccountData> {
    try {
      const chargesPath = `clients/${clientId}/condominiums/${condominiumId}/users/${userId}/charges`;
      this.logger.log(`Consultando estado de cuenta en: ${chargesPath}`);

      const chargesCollection = this.firestore.collection(chargesPath);
      const chargesSnapshot = await chargesCollection.get();

      if (chargesSnapshot.empty) {
        this.logger.warn(`No se encontraron cargos para el usuario ${userId}`);
        return {
          charges: [],
          payments: [],
          summary: {
            totalCharges: 0,
            totalPaid: 0,
            totalBalance: 0,
            totalCreditBalance: 0,
          },
        };
      }

      const charges: ChargeData[] = [];
      const payments: PaymentData[] = [];

      // Procesar cada cargo y sus pagos
      for (const chargeDoc of chargesSnapshot.docs) {
        const chargeData = chargeDoc.data() as ChargeData;
        chargeData.id = chargeDoc.id;
        charges.push(chargeData);

        // Obtener pagos de este cargo
        const paymentsCollection = chargeDoc.ref.collection('payments');
        const paymentsSnapshot = await paymentsCollection.get();

        for (const paymentDoc of paymentsSnapshot.docs) {
          const paymentData = paymentDoc.data() as PaymentData;
          paymentData.id = paymentDoc.id;
          payments.push(paymentData);
        }
      }

      // Calcular resumen
      const totalCharges = charges.reduce(
        (sum, charge) => sum + (charge.amount || 0),
        0,
      );
      const totalPaid = payments.reduce(
        (sum, payment) => sum + (payment.amountPaid || 0),
        0,
      );
      const totalCreditBalance = payments.reduce(
        (sum, payment) => sum + (payment.creditBalance || 0),
        0,
      );
      const totalBalance = totalCharges - totalPaid;

      this.logger.log(
        `Estado de cuenta obtenido: ${charges.length} cargos, ${payments.length} pagos`,
      );

      return {
        charges,
        payments,
        summary: {
          totalCharges,
          totalPaid,
          totalBalance,
          totalCreditBalance,
        },
      };
    } catch (error) {
      this.logger.error(
        `Error obteniendo estado de cuenta para ${userId}: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Convierte el número de mes a nombre en español
   */
  private getMonthName(monthNumber: string): string {
    const months = {
      '01': 'enero',
      '02': 'febrero',
      '03': 'marzo',
      '04': 'abril',
      '05': 'mayo',
      '06': 'junio',
      '07': 'julio',
      '08': 'agosto',
      '09': 'septiembre',
      '10': 'octubre',
      '11': 'noviembre',
      '12': 'diciembre',
    };
    return months[monthNumber] || monthNumber;
  }

  /**
   * Genera un PDF con el estado de cuenta del usuario
   */
  async generateAccountStatementPDF(
    accountData: ProcessedAccountData,
    userInfo: {
      name: string;
      email: string;
      departmentNumber: string;
      condominiumName?: string;
    },
  ): Promise<Buffer> {
    try {
      this.logger.log(
        `Generando PDF del estado de cuenta para ${userInfo.email}`,
      );

      const doc = new jsPDF();
      let yPos = 20;
      const pageWidth = doc.internal.pageSize.width;
      const pageHeight = doc.internal.pageSize.height;

      // Configurar colores indigo - Definir como tuple específico para TypeScript
      const indigoColor: [number, number, number] = [79, 70, 229]; // RGB para indigo-600
      const lightIndigoColor: [number, number, number] = [199, 210, 254]; // RGB para indigo-100

      // --- ENCABEZADO ---
      doc.setFillColor(indigoColor[0], indigoColor[1], indigoColor[2]);
      doc.rect(0, 0, pageWidth, 35, 'F');

      doc.setTextColor(255, 255, 255);
      doc.setFontSize(18);
      doc.setFont('helvetica', 'bold');
      doc.text('ESTADO DE CUENTA', 14, 20);

      doc.setFontSize(12);
      doc.setFont('helvetica', 'normal');
      const reportDate = new Date().toLocaleString('es-MX', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      doc.text(`Generado el: ${reportDate}`, 14, 30);

      // --- AGREGAR LOGO EN ESQUINA SUPERIOR DERECHA ---
      try {
        const logoUrl =
          'https://firebasestorage.googleapis.com/v0/b/administracioncondominio-93419.appspot.com/o/estateAdminUploads%2Fassets%2FlogoReportes.png?alt=media&token=ed962a4d-a493-41fc-a7a9-0536156ae727';

        // Descargar la imagen usando axios
        const logoResponse = await axios.get(logoUrl, {
          responseType: 'arraybuffer',
          timeout: 10000, // 10 segundos de timeout
        });

        // Convertir a base64
        const logoBase64 = Buffer.from(logoResponse.data).toString('base64');
        const logoDataUrl = `data:image/png;base64,${logoBase64}`;

        // Agregar logo al PDF en la esquina superior derecha (comprimido)
        doc.addImage(logoDataUrl, 'PNG', pageWidth - 90, 5, 80, 40);
      } catch (logoError) {
        this.logger.warn(`No se pudo cargar el logo: ${logoError.message}`);
        // Continuar sin logo si hay error
      }

      // Resetear color de texto
      doc.setTextColor(0, 0, 0);
      yPos = 50;

      // --- INFORMACIÓN DEL USUARIO ---
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.text('Información del Residente', 14, yPos);
      yPos += 10;

      doc.setFontSize(11);
      doc.setFont('helvetica', 'normal');

      const userInfoData = [
        ['Nombre:', userInfo.name],
        ['Email:', userInfo.email],
        ['Departamento/Casa:', userInfo.departmentNumber],
        ['Condominio:', userInfo.condominiumName || 'N/A'],
      ];

      userInfoData.forEach(([label, value]) => {
        doc.setFont('helvetica', 'bold');
        doc.text(label, 14, yPos);
        doc.setFont('helvetica', 'normal');
        doc.text(value, 14 + doc.getTextWidth(label) + 5, yPos);
        yPos += 6;
      });

      yPos += 10;

      // --- RESUMEN FINANCIERO ---
      doc.setFontSize(14);
      doc.setFont('helvetica', 'bold');
      doc.text('Resumen Financiero', 14, yPos);
      yPos += 5;

      // Calcular correctamente los totales siguiendo la lógica del componente React
      // 1. Total de Cargos = suma de todos los chargeAmountReference
      const totalCharges = accountData.charges.reduce(
        (sum, charge) =>
          sum + (charge.chargeAmountReference || charge.amount || 0),
        0,
      );

      // 2. Total de Monto Abonado = suma de amountPaid + creditBalance - creditUsed
      const totalPaid = accountData.payments.reduce((sum, payment) => {
        const amountPaid = payment.amountPaid || 0;
        const creditBalance = payment.creditBalance || 0;
        const creditUsed = payment.creditUsed || 0;
        return sum + amountPaid + creditBalance - creditUsed;
      }, 0);

      // 3. Saldo = Total de Cargos - Total de Monto Abonado
      const balance = totalCharges - totalPaid;

      const summaryData = [
        ['Total de Cargos', this.formatCurrency(totalCharges)],
        ['Total de Monto Abonado', this.formatCurrency(totalPaid)],
        ['Saldo', this.formatCurrency(balance)],
      ];

      autoTable(doc, {
        startY: yPos,
        head: [['Concepto', 'Monto']],
        body: summaryData,
        theme: 'grid',
        headStyles: {
          fillColor: indigoColor,
          fontStyle: 'bold',
          textColor: 255,
        },
        styles: {
          fontSize: 10,
          cellPadding: 3,
        },
        columnStyles: {
          1: { halign: 'right' },
        },
        didParseCell: (data) => {
          if (data.section === 'body' && data.column.index === 1) {
            const rowIndex = data.row.index;
            // Aplicar color solo a la fila del saldo (índice 2)
            if (rowIndex === 2) {
              if (balance < 0) {
                data.cell.styles.textColor = [0, 128, 0]; // Verde para saldo a favor
              } else if (balance > 0) {
                data.cell.styles.textColor = [220, 38, 38]; // Rojo para deuda
              }
            }
          }
        },
      });

      yPos = (doc as any).lastAutoTable?.finalY
        ? (doc as any).lastAutoTable.finalY + 15
        : yPos + 15;

      // --- DETALLE DE CARGOS ---
      if (accountData.charges.length > 0) {
        // Verificar si necesitamos nueva página
        if (yPos > pageHeight - 60) {
          doc.addPage();
          yPos = 20;
        }

        doc.setFontSize(14);
        doc.setFont('helvetica', 'bold');
        doc.text('Detalle de Cargos', 14, yPos);
        yPos += 5;

        const chargesTableData = accountData.charges.map((charge) => {
          // Agregar mes al concepto si existe la fecha de inicio
          let conceptWithMonth = charge.concept;
          if (charge.startAt) {
            try {
              // Extraer el mes de startAt (formato esperado: "YYYY-MM-DD HH:mm")
              const startDate = charge.startAt.substring(0, 10); // "YYYY-MM-DD"
              const monthPart = startDate.substring(5, 7); // "MM"
              const monthName = this.getMonthName(monthPart);
              conceptWithMonth = `${charge.concept} - ${monthName}`;
            } catch (error) {
              // Si hay error parseando la fecha, usar solo el concepto original
              this.logger.warn(
                `Error parseando startAt para cargo ${charge.id}: ${error.message}`,
              );
            }
          }

          return [
            conceptWithMonth,
            this.formatDate(charge.generatedAt),
            this.formatDate(charge.dueDate),
            this.formatCurrency(charge.chargeAmountReference || charge.amount), // Usar chargeAmountReference en lugar de amount
            charge.paid ? 'Pagado' : 'Pendiente',
          ];
        });

        autoTable(doc, {
          startY: yPos,
          head: [
            [
              'Concepto',
              'Fecha Generación',
              'Fecha Vencimiento',
              'Monto',
              'Estado',
            ],
          ],
          body: chargesTableData,
          theme: 'grid',
          headStyles: {
            fillColor: indigoColor,
            fontStyle: 'bold',
            textColor: 255,
          },
          styles: {
            fontSize: 9,
            cellPadding: 2,
          },
          columnStyles: {
            3: { halign: 'right' },
            4: { halign: 'center' },
          },
          didParseCell: (data) => {
            if (data.section === 'body' && data.column.index === 4) {
              const isPaid = data.cell.text[0] === 'Pagado';
              data.cell.styles.textColor = isPaid ? [0, 128, 0] : [220, 38, 38];
              data.cell.styles.fontStyle = 'bold';
            }
          },
        });

        yPos = (doc as any).lastAutoTable?.finalY
          ? (doc as any).lastAutoTable.finalY + 15
          : yPos + 15;
      }

      // --- HISTORIAL DE PAGOS ---
      if (accountData.payments.length > 0) {
        // Verificar si necesitamos nueva página
        if (yPos > pageHeight - 60) {
          doc.addPage();
          yPos = 20;
        }

        doc.setFontSize(14);
        doc.setFont('helvetica', 'bold');
        doc.text('Historial de Pagos', 14, yPos);
        yPos += 5;

        const paymentsTableData = accountData.payments.map((payment) => {
          // Agregar mes al concepto si existe
          let conceptWithMonth = payment.concept;
          if (payment.month) {
            const monthName = this.getMonthName(payment.month);
            conceptWithMonth = `${payment.concept} - ${monthName}`;
          }

          return [
            payment.folio,
            conceptWithMonth,
            this.formatDate(payment.paymentDate),
            payment.paymentType,
            this.formatCurrency(payment.amountPaid),
          ];
        });

        autoTable(doc, {
          startY: yPos,
          head: [
            ['Folio', 'Concepto', 'Fecha de Pago', 'Tipo de Pago', 'Monto'],
          ],
          body: paymentsTableData,
          theme: 'grid',
          headStyles: {
            fillColor: indigoColor,
            fontStyle: 'bold',
            textColor: 255,
          },
          styles: {
            fontSize: 9,
            cellPadding: 2,
          },
          columnStyles: {
            4: { halign: 'right' },
          },
        });

        yPos = (doc as any).lastAutoTable?.finalY
          ? (doc as any).lastAutoTable.finalY + 15
          : yPos + 15;

        // Agregar texto de contacto al final de la tabla de pagos
        if (yPos > pageHeight - 40) {
          doc.addPage();
          yPos = 20;
        }

        doc.setFontSize(9);
        doc.setFont('helvetica', 'italic');
        doc.setTextColor(120, 120, 120);
        doc.text(
          'Para cualquier aclaración sobre este estado de cuenta, por favor contacte a su administrador.',
          14,
          yPos,
        );
        yPos += 10;

        // Agregar disclaimer sobre fecha de pago
        doc.setFontSize(9);
        doc.setFont('helvetica', 'italic');
        doc.setTextColor(120, 120, 120);
        doc.text(
          '* La Fecha de Pago puede hacer referencia a la fecha en que se aplicó el pago en el sistema.',
          14,
          yPos,
        );
        yPos += 10;
      }

      // --- PIE DE PÁGINA ---
      // Usar el método correcto para obtener el número de páginas
      const totalPages = (doc as any).internal.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);

        // Línea separadora
        doc.setDrawColor(indigoColor[0], indigoColor[1], indigoColor[2]);
        doc.line(14, pageHeight - 25, pageWidth - 14, pageHeight - 25);

        // Información del pie
        doc.setFontSize(8);
        doc.setTextColor(100, 100, 100);
        doc.text(
          'Este documento es generado automáticamente por EstateAdmin',
          14,
          pageHeight - 15,
        );
        doc.text(
          `Página ${i} de ${totalPages}`,
          pageWidth - 30,
          pageHeight - 15,
        );
        doc.text(`Generado el ${reportDate}`, 14, pageHeight - 8);
        doc.text(
          'administracion@estate-admin.com',
          pageWidth - 80,
          pageHeight - 8,
        );
      }

      // Convertir a Buffer
      const pdfBuffer = Buffer.from(doc.output('arraybuffer'));
      this.logger.log('PDF del estado de cuenta generado exitosamente');

      return pdfBuffer;
    } catch (error) {
      this.logger.error(
        `Error generando PDF del estado de cuenta: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Formatea un valor monetario
   */
  private formatCurrency(value: number): string {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN',
      minimumFractionDigits: 2,
    }).format(value / 100); // Dividir por 100 porque viene en centavos
  }

  /**
   * Formatea una fecha desde Timestamp o string
   */
  private formatDate(date: admin.firestore.Timestamp | string): string {
    try {
      if (!date) return 'N/A';

      if (typeof date === 'string') {
        // Si es string, intentar parsearlo
        const parsedDate = new Date(date);
        if (isNaN(parsedDate.getTime())) return date; // Si no se puede parsear, devolver como está
        return parsedDate.toLocaleDateString('es-MX');
      } else {
        // Si es Timestamp de Firestore
        return date.toDate().toLocaleDateString('es-MX');
      }
    } catch (error) {
      this.logger.warn(`Error formateando fecha: ${error.message}`);
      return 'N/A';
    }
  }
}

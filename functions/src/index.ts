import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
const { MailerSend, EmailParams, Recipient, Sender } = require('mailersend');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const cors = require('cors');
const JSZip = require('jszip');
const twilio = require('twilio');


admin.initializeApp();

const corsHandler = cors({ origin: true });

exports.enviarEmailPorPublicacion = functions.firestore
  .document('clients/{clientId}/condominiums/{condominiumId}/publications/{publicationId}')
  .onCreate(async (snapshot: { data: () => any; }, context: { params: { clientId: any; condominiumId: any; }; }) => {
    const publicationData = snapshot.data();
    const { clientId, condominiumId } = context.params;

    const mailerSend = new MailerSend({
      apiKey: 'mlsn.04376e8c6118b2b07be6e6b79c9a0bcf9c92eb309231e485ca64d528b7c519fd',
    });

    const usersRef = admin.firestore().collection(`clients/${clientId}/condominiums/${condominiumId}/users`);
    const emailPromises: any[] = [];

    try {
      const usersSnapshot = await usersRef.get();

      usersSnapshot.docs.forEach((userDoc: { data: () => any; }) => {
        const userData = userDoc.data();

        // Determinar si el correo debe enviarse al usuario
        let shouldSendEmail = false;
        if (publicationData.sendTo === 'todos') {
          shouldSendEmail = true;
        } else if (Array.isArray(publicationData.sendTo)) {
          const fullName = `${userData.name} ${userData.lastName}`;
          shouldSendEmail = publicationData.sendTo.includes(fullName);
        } else {
          shouldSendEmail = publicationData.sendTo === userData.role;
        }

        if (userData.email && shouldSendEmail) {
          const htmlTemplate = (
            userData: any,
            publicationData: { title: any; content: any, condominiumName: any; },
            attachmentUrls: any[],
          ) => `
          <html>
          <head>
            <style>
              :root {
                font-family: 'Open Sans', sans-serif;
              }
              .button {
                background-color: #6366F1; 
                color: white; 
                padding: 20px; 
                text-align: center; 
                text-decoration: none; 
                display: inline-block; 
                border-radius: 5px;
                margin-top: 20px;
                color: #ffffff !important;
                font-size: 18px;
                font-weight: bold;
                width: 350px;
              }
              .footer-link {
                color: #6366F1 !important;
                text-decoration: none;
              }
            </style>
            <link rel="preconnect" href="https://fonts.googleapis.com">
            <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
            <link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300..800;1,300..800&display=swap" rel="stylesheet">
          </head>
          <body style="background-color: #f6f6f6;">
            <table width="80%" style="background-color: #ffffff; border-radius: 10px; padding: 50px 40px; margin: 40px auto 0 auto; box-shadow: 5px 5px 10px rgba(0, 0, 0, .1);" cellspacing="0" cellpadding="0">
            <tr>
              <td style="background-color: #6366F1; border-radius: 5px 5px 0 0; padding: 10px 0 0 0; text-align: center;">
                <img style="width: 140px; height: 140px; object-fit: contain;" src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2F2.png?alt=media&token=5fb84508-cad4-405c-af43-cd1a4f54f521" alt="EstateAdmin">
            </td>
            </tr>
            <tr>
              <td style="background-color: #6366F1; border-radius: 0 0 5px 5px; padding: 0 0 20px 0; text-align: center;">
                <h1 style="color: white; margin: 0; font-size: 24px;">Hay una nueva publicación</h1>
              </td>
            </tr>
              <tr>
                <td style="padding: 20px 0; text-align: center;">
                  <table style="width: 100%; margin: 20px auto 0 auto; background-color: #f6f6f6; padding: 20px 10px; border-radius: 10px;">
                    <tr>
                      <td style=" border-radius: 5px 5px 0 0; padding: 10px; text-align: center;">
                        <h2 style="color: #6366F1; font-size: 20px;">Hola, ${userData.name} Tu comunidad ${publicationData.condominiumName} ha emitido una nueva publicación</h2>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding: 10px 0; font-size: 22px; font-weight: bold; font-size: 18px;" width="200">${publicationData.title}</td>
                    </tr>
                    <tr>
                      <td style="padding: 10px 0; font-size: 20px; font-size: 16px;">${publicationData.content}</td>
                    </tr>
                    <tr>
                      <td style="text-align: center;">
                        <a href="https://www.urieel.dev" class="button">Ir a mi cuenta</a>
                      </td>
                    </tr>
                    ${attachmentUrls && attachmentUrls.length > 0
              ? `<tr>
                            <td style="text-align: center; padding-top: 20px;">
                              <h4 style="font-weight: bold">Archivos adjuntos:</h4>
                              ${attachmentUrls.map((url, index) => `<p><a href="${url}" style="color: #6366F1; font-size: 16px; margin: 10px 0;">Archivo Adjunto ${index + 1}</a></p>`).join("")}
                            </td>
                          </tr>`
              : ""
            }
                  </table>
                </td>
              </tr>
              <tr>
                <td style="background-color: #f6f6f6; border-radius: 10px 10px 0 0; padding: 10px; text-align: center;">
                  <img style="width: 100px; height: 100px; object-fit: contain;" src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2FLogo_omnipixel_2.png?alt=media&token=b71109fb-4489-40ee-a603-17dc40a1fb46" alt="Omnipixel">
                  <p style="font-weight: bold; font-size: 16px; margin: 0;">Modernidad y Eficacia en la Administración</p>
                </td>
              </tr>
              <tr>
                <td style="background-color: #f6f6f6; border-radius: 0 0 10px 10px; padding: 10px; text-align: center;">
                  <p style="font-weight: bold; font-size: 14px;">Síguenos en nuestras redes sociales:</p>
                  <p>
                    <a href="URL_FACEBOOK" class="footer-link">Facebook</a> | 
                    <a href="URL_TWITTER" class="footer-link">Twitter</a> | 
                    <a href="URL_INSTAGRAM" class="footer-link">Instagram</a>
                  </p>
                  <p>© Omnipixel</p>
                </td>
              </tr>
            </table>
          </body>
        </html>
      `;
          let emailHtml = htmlTemplate(
            userData,
            publicationData,
            publicationData.attachmentPublications,
          );

          const emailParams = new EmailParams()
            .setFrom(
              new Sender(
                'MS_D7g8Bo@estate-admin.com',
                'EstateAdmin Support',
              ),
            )
            .setTo([new Recipient(userData.email, userData.name || '')])
            .setReplyTo(
              new Sender(
                'MS_D7g8Bo@estate-admin.com',
                'EstateAdmin Support',
              ),
            )
            .setSubject(`Nueva publicación en ${publicationData.condominiumName}: ${publicationData.title}`)
            .setHtml(emailHtml);

          emailPromises.push(mailerSend.email.send(emailParams));
        }
      });

      await Promise.all(emailPromises);
      console.log(`Correos enviados exitosamente a los usuarios del condominio ${condominiumId}`);
    } catch (error) {
      console.error(`Error al enviar correos electrónicos al condominio ${condominiumId}:`, error);
    }
  });

////////////////////////////////////////// SEND EMAIL FOR PARCEL //////////////////////////////////////////

exports.enviarEmailPorRecepcionPaqueteria = functions.firestore
  .document('clients/{clientId}/condominiums/{condominiumId}/parcelReceptions/{parcelReceptionId}')
  .onCreate(async (snapshot: { data: () => any; }, context: { params: { clientId: any; condominiumId: any; parcelReceptionId: any; }; }) => {
    try {
      const parcelData = snapshot.data();
      const { clientId, condominiumId } = context.params;

      console.log('1 Datos del paquete:', parcelData);

      const mailerSend = new MailerSend({
        apiKey: 'mlsn.04376e8c6118b2b07be6e6b79c9a0bcf9c92eb309231e485ca64d528b7c519fd',
      });

      const usersRef = admin.firestore().collection(`clients/${clientId}/condominiums/${condominiumId}/users`);
      const emailPromises: any[] = [];

      const usersSnapshot = await usersRef.get();

      usersSnapshot.docs.forEach((userDoc: { data: () => any; }) => {
        const userData = userDoc.data();

        // Determinar si el correo debe enviarse al usuario
        let shouldSendEmail = false;

        // Lógica para determinar si se debe enviar el correo al usuario
        // Comprueba si el nombre y número coinciden con los datos del paquete
        if (userData.email === parcelData.email) {
          console.log('3 El paquete es para el usuario', userData.name, userData.number);
          shouldSendEmail = true;
        }

        if (userData.email && shouldSendEmail) {
          console.log('Enviando correo electrónico a', userData.email);
          // Plantilla HTML del correo electrónico para el aviso de paquete
          const htmlTemplate = (
            userData: any,
            parcelData: any,
          ) => `
          <html>
            <head>
                <style>
                :root {
                    font-family: 'Open Sans', sans-serif;
                }
                .button {
                    background-color: #6366F1; 
                    color: white; 
                    padding: 20px; 
                    text-align: center; 
                    text-decoration: none; 
                    display: inline-block; 
                    border-radius: 5px;
                    margin-top: 20px;
                    color: #ffffff !important;
                    font-size: 18px;
                    font-weight: bold;
                    width: 350px;
                }
                .footer-link {
                    color: #6366F1 !important;
                    text-decoration: none;
                }
                </style>
                <link rel="preconnect" href="https://fonts.googleapis.com">
                <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
                <link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300..800;1,300..800&display=swap" rel="stylesheet">
            </head>
      <body style="background-color: #f6f6f6;">
          <table width="80%" style="background-color: #ffffff; border-radius: 10px; padding: 50px 40px; margin: 40px auto 0 auto; box-shadow: 5px 5px 10px rgba(0, 0, 0, .1);" cellspacing="0" cellpadding="0">
          <tr>
          <td style="background-color: #6366F1; border-radius: 5px 5px 0 0; padding: 10px 0 0 0; text-align: center;">
              <img style="width: 140px; height: 140px; object-fit: contain;" src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2F2.png?alt=media&token=5fb84508-cad4-405c-af43-cd1a4f54f521" alt="EstateAdmin">
          </td>
          </tr>
          <tr>
          <td style="background-color: #6366F1; border-radius: 0 0 5px 5px; padding: 0 0 20px 0; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 24px;">Tu paquete te espera</h1>
          </td>
          </tr>
          <tr>
              <td style="padding: 20px 0; text-align: center;">
              <table style="width: 100%; margin: 20px auto 0 auto; background-color: #f6f6f6; padding: 20px 10px; border-radius: 10px;">
                  <tr>
                  <td style=" border-radius: 5px 5px 0 0; padding: 10px; text-align: center;">
                      <h2 style="color: #6366F1; font-size: 20px;">Hola, ${userData.name} <br> Tienes un paquete esperando a ser recogido en la recepción</h2>
                  </td>
                  </tr>
                  <tr>
                      <td style="padding: 10px 0; font-size: 20px; font-size: 16px;">Día y hora de la recepción: ${parcelData.dateReception} ${parcelData.hourReception} <br> <br> <br>
                          <p style="width: 100%; margin: 0 auto; padding: 10px 0; font-size: 14px; background-color: #6366F1; color: white; border-radius: 10px; font-weight: bold;">Nota: Recuerda presentar una identificación oficial para poder recoger el paquete</p>
                      </td>              
                  </tr>
              </table>
              </td>
          </tr>
          <tr>
              <td style="background-color: #f6f6f6; border-radius: 10px 10px 0 0; padding: 10px; text-align: center;">
              <img style="width: 100px; height: 100px; object-fit: contain;" src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2FLogo_omnipixel_2.png?alt=media&token=b71109fb-4489-40ee-a603-17dc40a1fb46" alt="Omnipixel">
              <p style="font-weight: bold; font-size: 16px; margin: 0;">Modernidad y Eficacia en la Administración</p>
              </td>
          </tr>
          <tr>
              <td style="background-color: #f6f6f6; border-radius: 0 0 10px 10px; padding: 10px; text-align: center;">
              <p style="font-weight: bold; font-size: 14px;">Síguenos en nuestras redes sociales:</p>
              <p>
                  <a href="URL_FACEBOOK" class="footer-link">Facebook</a> | 
                  <a href="URL_TWITTER" class="footer-link">Twitter</a> | 
                  <a href="URL_INSTAGRAM" class="footer-link">Instagram</a>
              </p>
              <p>© Omnipixel</p>
              </td>
          </tr>
          </table>
        </body>
    </html>
          `;
          let emailHtml = htmlTemplate(
            userData,
            parcelData,
          );

          const emailParams = new EmailParams()
            .setFrom(
              new Sender(
                'MS_D7g8Bo@estate-admin.com',
                'EstateAdmin Support',
              ),
            )
            .setTo([new Recipient(userData.email, userData.name || '')])
            .setReplyTo(
              new Sender(
                'MS_D7g8Bo@estate-admin.com',
                'EstateAdmin Support',
              ),
            )
            .setSubject(`¡Tienes un nuevo paquete en la recepción!`)
            .setHtml(emailHtml);

          emailPromises.push(mailerSend.email.send(emailParams));
        }
      });

      await Promise.all(emailPromises);
      console.log(`Correos enviados exitosamente a los usuarios del condominio ${condominiumId} sobre el paquete recibido`);
    } catch (error) {
      console.error(`Error al enviar correos electrónicos sobre el paquete recibido:`, error);
    }
  });

////////////////////////////////////////// SEND EMAIL FOR PAYMENT //////////////////////////////////////////
exports.enviarEmailConReportePdf = functions.firestore
  .document('clients/{clientId}/condominiums/{condominiumId}/payments/{paymentId}')
  .onCreate(async (snapshot: { data: () => any; }, context) => {
    try {
      const paymentData = snapshot.data();
      const { clientId, condominiumId, paymentId } = context.params;

      const mailerSend = new MailerSend({
        apiKey: 'mlsn.04376e8c6118b2b07be6e6b79c9a0bcf9c92eb309231e485ca64d528b7c519fd',
      });

      // Obtener los datos de contacto de la empresa
      const clientDoc = await admin.firestore().collection('clients').doc(clientId).get();
      const clientData = clientDoc.data();
      if (!clientData) {
        console.log('No se encontraron datos de la empresa');
        return;
      }

      const companyLogoUrl = clientData?.logoUrl || '';
      const companyEmail = clientData?.email || '';
      const companyPhone = clientData?.phoneNumber || '';
      const companyName = clientData?.companyName || '';

      const usersRef = admin.firestore().collection(`clients/${clientId}/condominiums/${condominiumId}/users`);
      const userSnapshot = await usersRef.where('email', '==', paymentData.email).get();

      if (userSnapshot.empty) {
        console.log('No se encontró un usuario con el email:', paymentData.email);
        return;
      }

      const userData = userSnapshot.docs[0].data();

      // Generar el folio EA-001, EA-002, etc.
      const paymentCountSnapshot = await admin.firestore()
        .collection('clients')
        .doc(clientId)
        .collection('condominiums')
        .doc(condominiumId)
        .collection('payments')
        .get();
      const folio = `EA-${String(paymentCountSnapshot.size + 1).padStart(3, '0')}`;

      // Formatear la hora y fecha en hora local
      const currentDate = new Date();
      const options: Intl.DateTimeFormatOptions = {
        timeZone: 'America/Mexico_City',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      };
      const formattedDateTime = currentDate.toLocaleString('es-MX', options);
      const [dateProcessed, timeProcessed] = formattedDateTime.split(', ');

      // Convertir el mes de pago a nombre de mes (ejemplo: "2024-08" a "Agosto 2024")
      const monthNames = [
        'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
      ];
      const [year, month] = paymentData.month.split('-');
      const monthName = `${monthNames[parseInt(month, 10) - 1]} ${year}`;

      // Generar el PDF en formato carta (8.5 x 11 pulgadas)
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([612, 792]); // Tamaño carta en puntos (8.5 x 11 pulgadas)
      const { width, height } = page.getSize();

      // Definir colores y fuentes
      const colorInstitucional = rgb(0.39, 0.4, 0.95); // #6366F1
      const fontSizeTitle = 22;
      const fontSizeText = 14;
      const fontSizeSmall = 12;
      const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);

      // Insertar la imagen como marca de agua (fondo)
      const watermarkUrl = 'https://firebasestorage.googleapis.com/v0/b/administracioncondominio-93419.appspot.com/o/estateAdminUploads%2Fassets%2FEstateAdminWatteMark.png?alt=media&token=653a790b-d7f9-4324-8c6d-8d1eaf9d5924';
      const watermarkBytes = await fetch(watermarkUrl).then((res) => res.arrayBuffer());
      const watermarkImage = await pdfDoc.embedPng(watermarkBytes);
      const watermarkDims = watermarkImage.scaleToFit(width * 0.8, height * 0.8); // Escalar la marca de agua para cubrir la mayor parte de la página

      // Dibujar la marca de agua en el centro de la página con opacidad
      page.drawImage(watermarkImage, {
        x: (width - watermarkDims.width) / 2,
        y: (height - watermarkDims.height) / 2,
        width: watermarkDims.width,
        height: watermarkDims.height,
        opacity: 0.1, // Hacer la imagen transparente para que sea una marca de agua sutil
      });

      // Insertar el membrete en la parte superior
      page.drawText(companyName, {
        x: 20,
        y: height - 40,
        size: fontSizeSmall,
        font: fontBold,
        color: rgb(0, 0, 0),
      });
      page.drawText(`Correo: ${companyEmail} | Teléfono: ${companyPhone}`, {
        x: 20,
        y: height - 60,
        size: fontSizeSmall,
        font: fontRegular,
        color: rgb(0, 0, 0),
      });

      // Insertar el logo con un ajuste similar a object-fit: cover
      const logoImageBytes = await fetch(companyLogoUrl).then((res) => res.arrayBuffer());
      const logoImage = await pdfDoc.embedPng(logoImageBytes);
      const logoDims = logoImage.scaleToFit(100, 50); // Ajusta el logo para no deformarse

      // Dibujar el header con fondo institucional y el logo a la derecha
      page.drawRectangle({
        x: 0,
        y: height - 80,
        width: width,
        height: 80,
        color: colorInstitucional,
      });

      page.drawText('Comprobante de pago', {
        x: 20,
        y: height - 50,
        size: fontSizeTitle,
        font: fontBold,
        color: rgb(1, 1, 1), // Blanco
      });

      page.drawImage(logoImage, {
        x: width - 120,
        y: height - 75,
        width: logoDims.width,
        height: logoDims.height,
      });

      // Fecha y hora de procesamiento
      page.drawText(`Fecha de procesamiento: ${dateProcessed} ${timeProcessed}`, {
        x: 20,
        y: height - 120,
        size: fontSizeText,
        font: fontRegular,
        color: rgb(0, 0, 0),
      });

      // Información del condómino y detalles del pago
      page.drawText(`Nombre del residente: ${userData.name}`, {
        x: 20,
        y: height - 150,
        size: fontSizeText,
        font: fontRegular,
        color: rgb(0, 0, 0),
      });

      page.drawText(`Medio de pago: Transferencia`, {
        x: 20,
        y: height - 180,
        size: fontSizeText,
        font: fontRegular,
        color: rgb(0, 0, 0),
      });

      page.drawText(`Mes pagado: ${monthName}`, {
        x: 20,
        y: height - 210,
        size: fontSizeText,
        font: fontRegular,
        color: rgb(0, 0, 0),
      });

      page.drawText(`Folio: ${folio}`, {
        x: 20,
        y: height - 240,
        size: fontSizeText,
        font: fontRegular,
        color: rgb(0, 0, 0),
      });

      // Dibujar la tabla
      const tableYStart = height - 290;
      const cellHeight = 30;
      const cellPadding = 12;
      const borderColor = rgb(0.39, 0.4, 0.95); // Color institucional

      // Dibujar los títulos de las columnas con fondo y borde
      page.drawRectangle({
        x: 15,
        y: tableYStart,
        width: 582, // Ajusta el ancho de la tabla para que no se vea pegada
        height: cellHeight,
        color: colorInstitucional,
      });

      page.drawText('Concepto', { x: 20, y: tableYStart + cellPadding, size: fontSizeText, font: fontBold, color: rgb(1, 1, 1) });
      page.drawText('Monto Pagado', { x: 220, y: tableYStart + cellPadding, size: fontSizeText, font: fontBold, color: rgb(1, 1, 1) });
      page.drawText('Saldo Pendiente', { x: 400, y: tableYStart + cellPadding, size: fontSizeText, font: fontBold, color: rgb(1, 1, 1) });

      // Dibujar los bordes de la tabla
      page.drawRectangle({
        x: 15,
        y: tableYStart - cellHeight,
        width: 582,
        height: cellHeight,
        borderColor: borderColor,
        borderWidth: 2,
      });

      // Dibujar los valores de la tabla con padding
      page.drawText('Cuota de mantenimiento', { x: 20, y: tableYStart - cellHeight + cellPadding, size: fontSizeText, font: fontRegular, color: rgb(0, 0, 0) });
      page.drawText(`$${paymentData.amountPaid}`, { x: 220, y: tableYStart - cellHeight + cellPadding, size: fontSizeText, font: fontRegular, color: rgb(0, 0, 0) });
      page.drawText(`$${paymentData.amountPending}`, { x: 400, y: tableYStart - cellHeight + cellPadding, size: fontSizeText, font: fontRegular, color: rgb(0, 0, 0) });

      // Dibujar el sello en la parte inferior derecha
      const selloUrl = 'https://firebasestorage.googleapis.com/v0/b/administracioncondominio-93419.appspot.com/o/estateAdminUploads%2Fassets%2FselloPagado.png?alt=media&token=e190c6bc-3983-4e63-af3b-900fc0ad355a'; // URL del sello
      const selloBytes = await fetch(selloUrl).then((res) => res.arrayBuffer());
      const selloImage = await pdfDoc.embedPng(selloBytes);
      const selloDims = selloImage.scale(0.25); // Ajustar el tamaño del sello

      page.drawImage(selloImage, {
        x: width - selloDims.width - 50,
        y: 320, // Posición en Y para el sello
        width: selloDims.width,
        height: selloDims.height,
      });

      // Dibujar el footer con un fondo que llegue hasta el final de la página
      const footerY = 0;
      page.drawRectangle({
        x: 0,
        y: footerY,
        width: width,
        height: 100,
        color: colorInstitucional,
      });

      page.drawText('Gracias por su pago.', {
        x: 20,
        y: footerY + 80,
        size: fontSizeText,
        font: fontBold,
        color: rgb(1, 1, 1),
      });

      page.drawText('Para cualquier duda o aclaración, contacte a su empresa administradora:', {
        x: 20,
        y: footerY + 60,
        size: fontSizeSmall,
        font: fontRegular,
        color: rgb(1, 1, 1),
      });

      page.drawText(`Correo: ${companyEmail}`, {
        x: 20,
        y: footerY + 40,
        size: fontSizeSmall,
        font: fontRegular,
        color: rgb(1, 1, 1),
      });

      page.drawText(`Teléfono: ${companyPhone}`, {
        x: 350,
        y: footerY + 40,
        size: fontSizeSmall,
        font: fontRegular,
        color: rgb(1, 1, 1),
      });

      // Generar el archivo PDF como un Buffer
      const pdfBytes = await pdfDoc.save();

      // Convertir el PDF a una cadena Base64 de manera explícita
      const pdfBase64 = Buffer.from(pdfBytes).toString('base64');

      // Subir el PDF a Firebase Storage
      const bucket = admin.storage().bucket();
      const filePath = `clients/${clientId}/condominiums/${condominiumId}/payments/${year}/${month}/${paymentId}/receipt.pdf`;
      const file = bucket.file(filePath);

      await file.save(Buffer.from(pdfBytes), {
        metadata: {
          contentType: 'application/pdf',
        },
        public: true,
      });

      const fileUrl = await file.getSignedUrl({
        action: 'read',
        expires: '03-09-2491', // Puedes ajustar la fecha de expiración
      });

      await admin.firestore()
        .collection('clients')
        .doc(clientId)
        .collection('condominiums')
        .doc(condominiumId)
        .collection('payments')
        .doc(paymentId)
        .update({
          receiptUrl: fileUrl[0],
        });

      // Crear el correo electrónico
      const emailParams = new EmailParams()
        .setFrom(new Sender('MS_D7g8Bo@estate-admin.com', 'EstateAdmin Support'))
        .setTo([new Recipient(userData.email, userData.name || '')])
        .setReplyTo(new Sender('MS_D7g8Bo@estate-admin.com', 'EstateAdmin Support'))
        .setSubject('¡Confirmación de Pago Recibido!')
        .setHtml(`
          <html>
            <head>
                <style>
                :root {
                    font-family: 'Open Sans', sans-serif;
                }
                .button {
                    background-color: #6366F1; 
                    color: white; 
                    padding: 20px; 
                    text-align: center; 
                    text-decoration: none; 
                    display: inline-block; 
                    border-radius: 5px;
                    margin-top: 20px;
                    color: #ffffff !important;
                    font-size: 18px;
                    font-weight: bold;
                    width: 350px;
                }
                .footer-link {
                    color: #6366F1 !important;
                    text-decoration: none;
                }
                </style>
                <link rel="preconnect" href="https://fonts.googleapis.com">
                <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
                <link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300..800;1,300..800&display=swap" rel="stylesheet">
            </head>
        <body style="background-color: #f6f6f6;">
          <table width="80%" style="background-color: #ffffff; border-radius: 10px; padding: 50px 40px; margin: 40px auto 0 auto; box-shadow: 5px 5px 10px rgba(0, 0, 0, .1);" cellspacing="0" cellpadding="0">
          <tr>
          <td style="background-color: #6366F1; border-radius: 5px 5px 0 0; padding: 10px 0 0 0; text-align: center;">
              <img style="width: 140px; height: 140px; object-fit: contain;" src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2F2.png?alt=media&token=5fb84508-cad4-405c-af43-cd1a4f54f521" alt="EstateAdmin">
          </td>
          </tr>
          <tr>
          <td style="background-color: #6366F1; border-radius: 0 0 5px 5px; padding: 0 0 20px 0; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 24px;">¡Confirmación de Pago Recibido!</h1>
          </td>
          </tr>
          <tr>
              <td style="padding: 20px 0; text-align: center;">
              <table style="width: 100%; margin: 20px auto 0 auto; background-color: #f6f6f6; padding: 20px 10px; border-radius: 10px;">
                  <tr>
                    <td style=" border-radius: 5px 5px 0 0; padding: 10px; text-align: center;">
                        <h2 style="color: #6366F1; font-size: 20px;">Hola, ${userData.name} <br> Hemos registrado tu pago exitosamente. </h2>
                    </td>
                  </tr>
                  <tr>
                     <td>
                          <p style="width: 100%; margin: 0 auto; padding: 10px 0; font-size: 14px; background-color: #6366F1; color: white; border-radius: 10px; font-weight: bold;">A continuación te compartimos tu comprobante de pago. </br> Agradecemos tu confianza.</p>
                      </td>              
                  </tr>
              </table>
              </td>
          </tr>
          <tr>
              <td style="background-color: #f6f6f6; border-radius: 10px 10px 0 0; padding: 10px; text-align: center;">
              <img style="width: 100px; height: 100px; object-fit: contain;" src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2FLogo_omnipixel_2.png?alt=media&token=b71109fb-4489-40ee-a603-17dc40a1fb46" alt="Omnipixel">
              <p style="font-weight: bold; font-size: 16px; margin: 0;">Modernidad y Eficacia en la Administración</p>
              </td>
            </tr>
            <tr>
                <td style="background-color: #f6f6f6; border-radius: 0 0 10px 10px; padding: 10px; text-align: center;">
                <p style="font-weight: bold; font-size: 14px;">Síguenos en nuestras redes sociales:</p>
                <p>
                    <a href="URL_FACEBOOK" class="footer-link">Facebook</a> | 
                    <a href="URL_TWITTER" class="footer-link">Twitter</a> | 
                    <a href="URL_INSTAGRAM" class="footer-link">Instagram</a>
                </p>
                <p>© Omnipixel</p>
                </td>
            </tr>
            </table>
          </body>
        </html>
        `)
        .setAttachments([
          {
            filename: 'comprobante-pago.pdf',
            content: pdfBase64,
            type: 'application/pdf',
            disposition: 'attachment',
          },
        ]);

      // Enviar el correo
      await mailerSend.email.send(emailParams);

      console.log(`Correo enviado exitosamente con el comprobante de pago en PDF a ${userData.email}`);
    } catch (error) {
      console.error('Error al enviar el correo con el comprobante de pago:', error);
    }
  });

  ////////////////////////////////////////// SEND WHATSAPP FOR PAYMENT //////////////////////////////////////////

  exports.enviarWhatsAppConPago = functions.firestore
  .document('clients/{clientId}/condominiums/{condominiumId}/payments/{paymentId}')
  .onCreate(async (snapshot, context) => {
    try {
      // 1. Extraer datos del pago y parámetros de la ruta
      const paymentData = snapshot.data();
      const { clientId, condominiumId, paymentId } = context.params;
      
      // 2. Obtener datos de la empresa
      const clientDoc = await admin.firestore().collection('clients').doc(clientId).get();
      const clientData = clientDoc.data();
      if (!clientData) {
        console.log('No se encontraron datos de la empresa');
        return;
      }
      
      // 3. Obtener datos del usuario (buscando por el email del pago)
      const usersRef = admin.firestore().collection(`clients/${clientId}/condominiums/${condominiumId}/users`);
      const userSnapshot = await usersRef.where('email', '==', paymentData.email).get();
      if (userSnapshot.empty) {
        console.log('No se encontró un usuario con el email:', paymentData.email);
        return;
      }
      const userData = userSnapshot.docs[0].data();
      
      // 4. Generar el folio (por ejemplo: EA-001, EA-002, etc.)
      const paymentCountSnapshot = await admin.firestore()
        .collection('clients')
        .doc(clientId)
        .collection('condominiums')
        .doc(condominiumId)
        .collection('payments')
        .get();
      const folio = `EA-${String(paymentCountSnapshot.size + 1).padStart(3, '0')}`;

      // 5. Formatear la fecha y hora en hora local (America/Mexico_City)
      const currentDate = new Date();
      const options: Intl.DateTimeFormatOptions = ({
        timeZone: 'America/Mexico_City',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      } as Intl.DateTimeFormatOptions);
      const formattedDateTime = currentDate.toLocaleString('es-MX', options);
      const [dateProcessed, timeProcessed] = formattedDateTime.split(', ');

      // 6. Convertir el mes de pago (formato "YYYY-MM") a nombre de mes (por ejemplo: "Agosto 2024")
      const monthNames = [
        'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
        'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
      ];
      // Se asume que paymentData.month tiene formato "YYYY-MM"
      const [yearStr, monthStr] = paymentData.month.split('-');
      const monthName = `${monthNames[parseInt(monthStr, 10) - 1]} ${yearStr}`;

      // 7. Crear el cuerpo del mensaje de WhatsApp con los detalles del pago
      const messageBody = `Nuevo pago registrado:
                          ID de Pago: ${paymentId}
                          Folio: ${folio}
                          Fecha de procesamiento: ${dateProcessed} ${timeProcessed}
                          Nombre del residente: ${userData.name}
                          Medio de pago: Transferencia
                          Mes pagado: ${monthName}
                          Monto Pagado: $${paymentData.amountPaid}
                          Saldo Pendiente: $${paymentData.amountPending}
                          ¡Gracias por tu pago!`;

      // 8. Inicializar el cliente de Twilio usando las credenciales de las variables de entorno
      const accountSid = functions.config().twilio.account_sid;
      const authToken = functions.config().twilio.auth_token;
      const whatsappFrom = functions.config().twilio.whatsapp_from; // Ejemplo: 'whatsapp:+14155238886'
      const clientTwilio = twilio(accountSid, authToken);

      // 9. Definir el número de WhatsApp destino (fijo para pruebas)
      const whatsappTo = 'whatsapp:+5215531139560';

      console.log('whatsapp_from:', functions.config().twilio.whatsapp_from);

      // 10. Enviar el mensaje de WhatsApp
      const message = await clientTwilio.messages.create({
        from: whatsappFrom,
        to: whatsappTo,
        body: messageBody,
      });

      console.log(`Mensaje de WhatsApp enviado con SID: ${message.sid}`);
    } catch (error) {
      console.error('Error al enviar el mensaje de WhatsApp:', error);
    }
  });

////////////////////////////////////////// SEND EMAIL FOR RECEIPTS//////////////////////////////////////////
exports.sendReceiptsByEmail = functions.https.onRequest(async (req, res) => {
  corsHandler(req, res, async () => {
    // Manejo de solicitudes preflight (OPTIONS)
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, POST');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
      res.status(204).send('');
      return;
    }

    try {
      // Extraer parámetros desde la query string
      const { year, month, clientId, condominiumId, email, docType } = req.query;
      if (!year || !month || !clientId || !condominiumId || !email || !docType) {
        res.status(400).send('Faltan parámetros necesarios: year, month, clientId, condominiumId, email y docType.');
        return;
      }

      // Asegurar que el mes tenga dos dígitos (por ejemplo, '8' se convierte en '08')
      const monthString = month.toString().padStart(2, '0');
      const queryMonth = `${year}-${monthString}`;

      // Consulta la colección de pagos en Firestore filtrando por el campo "month"
      const paymentsRef = admin.firestore().collection(`clients/${clientId}/condominiums/${condominiumId}/payments`);
      const snapshot = await paymentsRef.where('month', '==', queryMonth).get();

      if (snapshot.empty) {
        res.status(404).send('No se encontraron documentos para la fecha indicada.');
        return;
      }

      // Crear el archivo ZIP y agregar cada archivo descargado según el tipo seleccionado
      const zip = new JSZip();
      const storageBaseUrl = "https://storage.googleapis.com/administracioncondominio-93419.appspot.com/";

      // docType se espera que sea "comprobantes" o "recibos"
      for (const doc of snapshot.docs) {
        const data = doc.data();
        let fileUrl: string | null = null;
        
        if (docType === 'recibos') {
          // Para recibos se usa directamente el campo receiptUrl
          fileUrl = data.receiptUrl ? String(data.receiptUrl) : null;
        } else {
          // Para comprobantes se usa el campo attachmentPayment y se genera un Signed URL
          if (data.attachmentPayment) {
            let filePath = String(data.attachmentPayment);
            if (filePath.startsWith(storageBaseUrl)) {
              filePath = filePath.substring(storageBaseUrl.length);
            }
            const bucket = admin.storage().bucket();
            const file = bucket.file(filePath);
            const [signedUrl] = await file.getSignedUrl({
              action: 'read',
              expires: Date.now() + 60 * 60 * 1000, // Validez de 1 hora
            });
            fileUrl = signedUrl;
          }
        }

        if (fileUrl) {
          try {
            const response = await fetch(fileUrl);
            if (!response.ok) {
              console.error(`Error al descargar el archivo para ${doc.id}: ${response.statusText}`);
              continue;
            }
            const arrayBuffer = await response.arrayBuffer();
            const fileBuffer = Buffer.from(arrayBuffer);
            // Usar el campo numberCondominium para nombrar el archivo: numberCondominium-fecha-docId.pdf
            const numberCondominium = data.numberCondominium ? String(data.numberCondominium) : 'unknown';
            const fileName = `numero-${numberCondominium}-${queryMonth}-${doc.id}.pdf`;
            zip.file(fileName, fileBuffer);
          } catch (error) {
            console.error(`Error procesando el documento ${doc.id}:`, error);
          }
        }
      }

      // Generar el ZIP como un Buffer (tipo nodebuffer)
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

      // Definir la plantilla HTML del correo electrónico
      const htmlTemplate = (userData: any, receiptsInfo: any) => `
            <html>
              <head>
                  <style>
                  :root { font-family: 'Open Sans', sans-serif; }
                  .button {
                      background-color: #6366F1; color: white; padding: 20px; text-align: center;
                      text-decoration: none; display: inline-block; border-radius: 5px; margin-top: 20px;
                      font-size: 18px; font-weight: bold; width: 350px;
                  }
                  .footer-link { color: #6366F1 !important; text-decoration: none; }
                  </style>
                  <link rel="preconnect" href="https://fonts.googleapis.com">
                  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
                  <link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300..800;1,300..800&display=swap" rel="stylesheet">
              </head>
              <body style="background-color: #f6f6f6;">
                  <table width="80%" style="background-color: #ffffff; border-radius: 10px; padding: 50px 40px; margin: 40px auto 0 auto;
                      box-shadow: 5px 5px 10px rgba(0, 0, 0, .1);" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="background-color: #6366F1; border-radius: 5px 5px 0 0; padding: 10px 0 0 0; text-align: center;">
                      <img style="width: 140px; height: 140px; object-fit: contain;"
                          src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2F2.png?alt=media&token=5fb84508-cad4-405c-af43-cd1a4f54f521"
                          alt="EstateAdmin">
                    </td>
                  </tr>
                  <tr>
                    <td style="background-color: #6366F1; border-radius: 0 0 5px 5px; padding: 0 0 20px 0; text-align: center;">
                      <h1 style="color: white; margin: 0; font-size: 24px;">Tus documentos están disponibles</h1>
                    </td>
                  </tr>
                  <tr>
                      <td style="padding: 20px 0; text-align: center;">
                        <p style="font-size: 16px;">Hola, ${userData.name}, adjunto encontrarás los documentos de pago correspondientes al mes ${receiptsInfo.month} del año ${receiptsInfo.year}.</p>
                        <p style="font-size: 14px;">Revisa el archivo adjunto para ver todos los documentos.</p>
                      </td>
                  </tr>
                  <tr>
                      <td style="background-color: #f6f6f6; border-radius: 10px 10px 0 0; padding: 10px; text-align: center;">
                        <img style="width: 100px; height: 100px; object-fit: contain;"
                            src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2FLogo_omnipixel_2.png?alt=media&token=b71109fb-4489-40ee-a603-17dc40a1fb46"
                            alt="Omnipixel">
                        <p style="font-weight: bold; font-size: 16px; margin: 0;">Modernidad y Eficacia en la Administración</p>
                      </td>
                  </tr>
                  <tr>
                      <td style="background-color: #f6f6f6; border-radius: 0 0 10px 10px; padding: 10px; text-align: center;">
                        <p style="font-weight: bold; font-size: 14px;">Síguenos en nuestras redes sociales:</p>
                        <p>
                            <a href="URL_FACEBOOK" class="footer-link">Facebook</a> | 
                            <a href="URL_TWITTER" class="footer-link">Twitter</a> | 
                            <a href="URL_INSTAGRAM" class="footer-link">Instagram</a>
                        </p>
                        <p>© Omnipixel</p>
                      </td>
                  </tr>
                  </table>
              </body>
            </html>
      `;

      const userData = {
        name: email as string,
        email: email as string,
      };

      const receiptsInfo = { year: year, month: monthString };
      const emailHtml = htmlTemplate(userData, receiptsInfo);

      const mailerSend = new MailerSend({
        apiKey: 'mlsn.04376e8c6118b2b07be6e6b79c9a0bcf9c92eb309231e485ca64d528b7c519fd',
      });

      const emailParams = new EmailParams()
        .setFrom(new Sender('MS_D7g8Bo@estate-admin.com', 'EstateAdmin Support'))
        .setTo([new Recipient(userData.email, userData.name)])
        .setReplyTo(new Sender('MS_D7g8Bo@estate-admin.com', 'EstateAdmin Support'))
        .setSubject(`Tus documentos de pago para ${monthString}-${year}`)
        .setHtml(emailHtml)
        .setAttachments([
          {
            filename: `documentos_${year}-${monthString}.zip`,
            content: zipBuffer.toString('base64'),
          },
        ]);

      await mailerSend.email.send(emailParams);
      res.send('Correo enviado correctamente');
    } catch (error) {
      console.error("Error en sendReceiptsByEmail:", error);
      res.status(500).send('Error interno en el servidor');
    }
  });
});


////////////////////////////////////////// SEND EMAIL FOR CALENDAR EVENTS //////////////////////////////////////////
exports.enviarEmailPorCalendarEvent = functions.firestore
  .document("clients/{clientId}/condominiums/{condominiumId}/calendarEvents/{calendarEventId}")
  .onCreate(async (snapshot, context) => {
    const eventData = snapshot.data();
    const { clientId, condominiumId } = context.params;

    // Solo enviar correo si el registro tiene el campo "email"
    if (!eventData.email) {
      console.log("No se encontró el campo 'email' en el registro; no se enviará correo.");
      return null;
    }

    const mailerSend = new MailerSend({
      apiKey: "YOUR_MAILERSEND_API_KEY_HERE", // Reemplaza con tu API Key
    });

    const htmlTemplate = `
      <html>
        <head>
          <style>
            body {
              font-family: 'Open Sans', sans-serif;
              background-color: #f6f6f6;
              margin: 0;
              padding: 0;
            }
            .container {
              width: 80%;
              background-color: #ffffff;
              border-radius: 10px;
              padding: 50px 40px;
              margin: 40px auto;
              box-shadow: 5px 5px 10px rgba(0, 0, 0, 0.1);
            }
            .header {
              background-color: #6366F1;
              border-radius: 5px 5px 0 0;
              padding: 20px;
              text-align: center;
            }
            .header h1 {
              color: #fff;
              font-size: 24px;
              margin: 0;
            }
            .content {
              padding: 20px;
              text-align: center;
            }
            .button {
              background-color: #6366F1;
              color: white;
              padding: 20px;
              text-align: center;
              text-decoration: none;
              display: inline-block;
              border-radius: 5px;
              margin-top: 20px;
              font-size: 18px;
              font-weight: bold;
              width: 350px;
            }
            .footer {
              background-color: #f6f6f6;
              padding: 20px;
              text-align: center;
              border-radius: 0 0 10px 10px;
              font-size: 14px;
            }
          </style>
          <link rel="preconnect" href="https://fonts.googleapis.com">
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
          <link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;600;700&display=swap" rel="stylesheet">
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1>Nuevo Evento Registrado</h1>
            </div>
            <div class="content">
              <p>Se ha registrado un nuevo evento en el condominio <strong>${condominiumId}.</p>
              <table style="width: 100%; margin-top: 20px; background-color: #f9f9f9; padding: 20px; border-radius: 8px;">
                <tr>
                  <td style="padding-bottom: 10px; font-size: 16px; color: #333;"><strong>Nombre del Evento:</strong> ${eventData.name || "N/A"}</td>
                </tr>
                <tr>
                  <td style="padding-bottom: 10px; font-size: 16px; color: #333;"><strong>Número de Residente:</strong> ${eventData.number || "N/A"}</td>
                </tr>
                <tr>
                  <td style="padding-bottom: 10px; font-size: 16px; color: #333;"><strong>Área Reservada:</strong> ${eventData.commonArea || "N/A"}</td>
                </tr>
                <tr>
                  <td style="padding-bottom: 10px; font-size: 16px; color: #333;"><strong>Fecha del Evento:</strong> ${eventData.eventDay || "N/A"}</td>
                </tr>
                <tr>
                  <td style="padding-bottom: 10px; font-size: 16px; color: #333;"><strong>Horario:</strong> ${eventData.startTime || "N/A"} - ${eventData.endTime || "N/A"}</td>
                </tr>
                ${
                  eventData.comments
                    ? `<tr>
                         <td style="padding-bottom: 10px; font-size: 16px; color: #333;"><strong>Comentarios:</strong> ${eventData.comments}</td>
                       </tr>`
                    : ""
                }
              </table>
            </div>
            <div class="footer">
              <p>Un servicio de Omnipixel</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const emailParams = new EmailParams()
      .setFrom(new Sender("noreply@yourdomain.com", "EstateAdmin Support"))
      .setTo([new Recipient(eventData.email, eventData.name || "Residente")])
      .setReplyTo(new Sender("noreply@yourdomain.com", "EstateAdmin Support"))
      .setSubject(`Nuevo Evento en Condominio ${condominiumId} (Cliente: ${clientId})`)
      .setHtml(htmlTemplate);

    try {
      await mailerSend.email.send(emailParams);
      console.log(`Correo enviado exitosamente a ${eventData.email}`);
    } catch (error) {
      console.error(`Error al enviar correo electrónico: `, error);
    }
    return null;
  });

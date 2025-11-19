// Script para verificar el token de WhatsApp
const axios = require('axios');
require('dotenv').config();

async function verifyWhatsAppToken() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.PHONE_NUMBER_ID;
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v22.0';

  if (!token) {
    console.error('❌ WHATSAPP_ACCESS_TOKEN no está definido en .env');
    return;
  }

  if (!phoneNumberId) {
    console.error('❌ PHONE_NUMBER_ID no está definido en .env');
    return;
  }

  console.log('🔍 Verificando token de WhatsApp...');
  console.log(`📱 Phone Number ID: ${phoneNumberId}`);
  console.log(`🔑 Token (primeros 20 chars): ${token.substring(0, 20)}...`);
  console.log(`📡 API Version: ${apiVersion}\n`);

  try {
    // Verificar el token obteniendo información del número de teléfono
    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}`;

    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      params: {
        fields: 'id,verified_name,display_phone_number,quality_rating',
      },
    });

    console.log('✅ Token VÁLIDO y FUNCIONANDO\n');
    console.log('📋 Información del número de WhatsApp:');
    console.log(JSON.stringify(response.data, null, 2));
    console.log('\n✨ El token está activo y tiene los permisos correctos.');
  } catch (error) {
    if (error.response) {
      console.error('❌ ERROR: Token INVÁLIDO o EXPIRADO\n');
      console.error('Código de estado:', error.response.status);
      console.error(
        'Mensaje:',
        error.response.data.error?.message || 'Error desconocido',
      );
      console.error('\nDetalles completos:');
      console.error(JSON.stringify(error.response.data, null, 2));

      if (error.response.status === 401) {
        console.error('\n🔧 SOLUCIÓN:');
        console.error('1. Ve a https://developers.facebook.com/');
        console.error('2. Selecciona tu app de WhatsApp');
        console.error('3. Ve a WhatsApp > API Setup');
        console.error(
          '4. Genera un nuevo token permanente (System User Token)',
        );
        console.error(
          '5. Actualiza WHATSAPP_ACCESS_TOKEN en tu .env y en Cloud Run',
        );
      }
    } else {
      console.error('❌ Error de conexión:', error.message);
    }
  }
}

verifyWhatsAppToken();

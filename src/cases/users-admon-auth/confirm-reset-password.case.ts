import axios from 'axios';
import { ConfirmResetPasswordDto } from '../../dtos/confirm-reset-password.dto';
import {
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';

export const confirmResetPassword = async (
  confirmResetPasswordDto: ConfirmResetPasswordDto,
) => {
  const { oobCode, newPassword } = confirmResetPasswordDto;

  try {
    if (!oobCode) {
      throw new BadRequestException(
        'Código de restablecimiento de contraseña inválido',
      );
    }

    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException(
        'La contraseña debe tener al menos 8 caracteres',
      );
    }

    const cleanOobCode = oobCode.split('&')[0];

    try {
      // Usar la API REST de Firebase
      const response = await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=${process.env.FIREBASE_API_KEY}`,
        { oobCode: cleanOobCode, newPassword: newPassword },
      );

      return {
        success: true,
        message: 'Contraseña actualizada exitosamente.',
        email: response.data.email,
      };
    } catch (error: any) {
      console.error(
        'Error al procesar el restablecimiento de contraseña:',
        error.response?.data || error,
      );

      const firebaseError = error.response?.data?.error;
      if (firebaseError) {
        switch (firebaseError.message) {
          case 'INVALID_OOB_CODE':
            throw new BadRequestException({
              message:
                'El código de restablecimiento ha expirado o es inválido',
              error: {
                code: firebaseError.code,
                message: firebaseError.message,
              },
            });
          case 'EXPIRED_OOB_CODE':
            throw new BadRequestException({
              message: 'El código de restablecimiento ha expirado',
              error: {
                code: firebaseError.code,
                message: firebaseError.message,
              },
            });
          case 'WEAK_PASSWORD':
            throw new BadRequestException({
              message: 'La contraseña es demasiado débil',
              error: {
                code: firebaseError.code,
                message: firebaseError.message,
              },
            });
          default:
            throw new BadRequestException({
              message: 'Error al procesar el restablecimiento de contraseña',
              error: {
                code: firebaseError.code,
                message: firebaseError.message,
              },
            });
        }
      }
      throw error;
    }
  } catch (error: any) {
    if (error instanceof BadRequestException) {
      throw error;
    }

    console.error('Error inesperado al restablecer la contraseña:', error);
    throw new InternalServerErrorException({
      message: 'Error al confirmar el restablecimiento de contraseña',
      error: { code: error.code, message: error.message },
    });
  }
};

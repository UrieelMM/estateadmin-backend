import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { Request } from 'express';

export type FinancialAdminActor = {
  uid: string;
  email: string;
  name: string;
};

export const getHeaderValue = (req: Request, headerName: string): string => {
  const raw = req.headers[headerName];
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw) && raw.length) return String(raw[0]).trim();
  return '';
};

export const getRequestIp = (req: Request): string => {
  const forwarded = getHeaderValue(req, 'x-forwarded-for');
  return forwarded ? forwarded.split(',')[0].trim() : req.ip || '';
};

export async function resolveFinancialAdmin(
  req: Request,
  clientId: string,
  condominiumId: string,
): Promise<FinancialAdminActor> {
  if (
    !clientId ||
    !condominiumId ||
    clientId.includes('/') ||
    condominiumId.includes('/')
  ) {
    throw new BadRequestException('Selecciona un cliente y un condominio válidos.');
  }

  const authHeader = getHeaderValue(req, 'authorization');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    throw new UnauthorizedException('Authorization Bearer token requerido.');
  }

  let decoded: admin.auth.DecodedIdToken;
  try {
    decoded = await admin.auth().verifyIdToken(token, true);
  } catch {
    throw new UnauthorizedException('Token inválido o expirado.');
  }

  if (decoded.clientId !== clientId || decoded.role !== 'admin') {
    throw new ForbiddenException(
      'Solo un administrador del condominio puede realizar esta operación.',
    );
  }

  const adminSnap = await admin
    .firestore()
    .doc(`clients/${clientId}/condominiums/${condominiumId}/users/${decoded.uid}`)
    .get();
  const adminData = adminSnap.data() || {};
  if (!adminSnap.exists || adminData.role !== 'admin' || adminData.active === false) {
    throw new ForbiddenException(
      'El administrador no pertenece al condominio seleccionado.',
    );
  }

  return {
    uid: decoded.uid,
    email: decoded.email || '',
    name: [adminData.name, adminData.lastName].filter(Boolean).join(' ').trim(),
  };
}

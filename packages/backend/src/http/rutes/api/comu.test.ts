import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { UsuariResolt } from '../../resoldre-usuari.js';
import { crearGuardaModul } from './comu.js';

function mockReply(): {
  reply: FastifyReply;
  code: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
} {
  const reply = {} as FastifyReply;
  const code = vi.fn().mockReturnValue(reply);
  const send = vi.fn().mockReturnValue(reply);
  reply.code = code;
  reply.send = send;
  return { reply, code, send };
}

function usuariAmb(modulsPermesos: string[]): UsuariResolt {
  return {
    id: 1,
    firebaseUid: 'uid',
    nom: 'X',
    email: 'x@example.com',
    rol: { id: 1, nom: 'Rol', modulsPermesos },
    actiu: true,
  };
}

/**
 * Regresión directa de un bug real (POST /usuaris colgado indefinidamente
 * en producción): `crearGuardaModul` es un
 * `preHandler` de Fastify, que SIEMPRE lo invoca como
 * `fn(request, reply, done)` — si el hook no llama a `done()` ni devuelve
 * una Promise, Fastify se queda esperando esa señal para siempre (sin
 * error, sin timeout). Este test llama al hook exactamente como lo hace
 * Fastify (3 argumentos posicionales, incluido `done`) para verificar el
 * contrato explícito, no sólo el resultado de negocio.
 */
describe('crearGuardaModul — contrato de preHandler de Fastify', () => {
  it('con el módulo requerido: llama a done() y NO envía ninguna respuesta', () => {
    const guarda = crearGuardaModul('usuaris');
    const req = { usuariResolt: usuariAmb(['usuaris']) } as unknown as FastifyRequest;
    const { reply, code, send } = mockReply();
    const done = vi.fn();

    guarda(req, reply, done);

    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith();
    expect(code).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('sense el mòdul requerit: envia 403 SENSE_PERMIS i NO crida done() (evitaria un doble enviament)', () => {
    const guarda = crearGuardaModul('usuaris');
    const req = { usuariResolt: usuariAmb(['comandes']) } as unknown as FastifyRequest;
    const { reply, code, send } = mockReply();
    const done = vi.fn();

    guarda(req, reply, done);

    expect(code).toHaveBeenCalledWith(403);
    expect(send).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
  });

  it('sense usuariResolt (no hauria de passar mai en producció, però defensiu): envia 403 i NO crida done()', () => {
    const guarda = crearGuardaModul('usuaris');
    const req = { usuariResolt: undefined } as unknown as FastifyRequest;
    const { reply, code } = mockReply();
    const done = vi.fn();

    guarda(req, reply, done);

    expect(code).toHaveBeenCalledWith(403);
    expect(done).not.toHaveBeenCalled();
  });

  // B1 (endpoints de "apoyo"): crearGuardaModul acepta una lista de módulos
  // — basta con tener UNO CUALQUIERA de ellos, no todos.
  it('con una lista de módulos: basta con tener UNO CUALQUIERA para llamar a done()', () => {
    const guarda = crearGuardaModul(['comandes', 'panell-oficina', 'panell-obrador']);
    const req = { usuariResolt: usuariAmb(['panell-obrador']) } as unknown as FastifyRequest;
    const { reply, code, send } = mockReply();
    const done = vi.fn();

    guarda(req, reply, done);

    expect(done).toHaveBeenCalledTimes(1);
    expect(code).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('con una lista de módulos: sin NINGUNO de ellos, envía 403 y no llama a done()', () => {
    const guarda = crearGuardaModul(['comandes', 'panell-oficina', 'panell-obrador']);
    const req = { usuariResolt: usuariAmb(['usuaris']) } as unknown as FastifyRequest;
    const { reply, code, send } = mockReply();
    const done = vi.fn();

    guarda(req, reply, done);

    expect(code).toHaveBeenCalledWith(403);
    expect(send).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
  });
});

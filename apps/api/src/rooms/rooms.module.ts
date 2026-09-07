import { Module, type DynamicModule } from '@nestjs/common';
import { RoomsController } from './rooms.controller';
import { ROOMS_RUNTIME, type RoomsRuntime } from './rooms.runtime';
import { RoomsService } from './rooms.service';

@Module({})
export class RoomsModule {
  /**
   * Same shape as `AuthModule.forConfig`: the runtime is passed in rather than
   * built here.
   *
   * It is REQUIRED rather than optional, and there is no default. A default
   * constructed inside this module would open a SECOND `pg` pool against the same
   * database as the same role — and, in a test, a second store that the assertions
   * are not looking at. `AppModule.forConfig` builds the one runtime and hands it to
   * everybody who needs an adapter.
   *
   * No `config` parameter, unlike `AuthModule`: nothing about creating a room reads
   * the environment. Taking one "for symmetry" would be an unused dependency that
   * the next person assumes is load-bearing.
   *
   * `SessionAuthenticator` is not provided here — `SessionAuthenticatorModule` is
   * `@Global()` and exports the one instance for the process, which is what makes
   * "who is calling" have a single answer across the guard, `AuthService` and this
   * module.
   */
  static forRuntime(runtime: RoomsRuntime): DynamicModule {
    return {
      module: RoomsModule,
      controllers: [RoomsController],
      providers: [RoomsService, { provide: ROOMS_RUNTIME, useValue: runtime }],
    };
  }
}

import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ActivityLogController } from './activity-log.controller';
import { ActivityLogService } from './activity-log.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DatabaseController } from './database.controller';
import { DatabaseService } from './database.service';
import { ResultAnalysisController } from './result-analysis.controller';
import { ResultAnalysisService } from './result-analysis.service';
import { InventoryControlController } from './inventory-control.controller';
import { InventoryControlService } from './inventory-control.service';
import { FinancialControlController } from './financial-control.controller';
import { FinancialControlService } from './financial-control.service';
import { PayrollController } from './payroll.controller';
import { PayrollService } from './payroll.service';
import { RegistrationController } from './registration.controller';
import { RegistrationService } from './registration.service';

@Module({
  imports: [],
  controllers: [
    AppController,
    DatabaseController,
    AuthController,
    ResultAnalysisController,
    InventoryControlController,
    FinancialControlController,
    PayrollController,
    RegistrationController,
    ActivityLogController,
  ],
  providers: [
    AppService,
    DatabaseService,
    ActivityLogService,
    AuthService,
    ResultAnalysisService,
    InventoryControlService,
    FinancialControlService,
    PayrollService,
    RegistrationService,
  ],
})
export class AppModule {}

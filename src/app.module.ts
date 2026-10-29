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
import { CampusSetupController } from './campus-setup.controller';
import { CampusSetupService } from './campus-setup.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UserRolesController } from './user-roles.controller';
import { UserRolesService } from './user-roles.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { FeeIncrementController } from './fee-increment.controller';
import { FeeIncrementService } from './fee-increment.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
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
    CampusSetupController,
    UsersController,
    UserRolesController,
    ActivityLogController,
    SettingsController,
    FeeIncrementController,
    DashboardController,
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
    CampusSetupService,
    UsersService,
    UserRolesService,
    SettingsService,
    FeeIncrementService,
    DashboardService,
  ],
})
export class AppModule {}

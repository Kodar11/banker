import { classicLoanStanding, type LoanState } from '@/engine/index.ts';

/**
 * When a Classic loan's principal must be repaid, in words — read from the engine's own standing
 * (classicLoanStanding), so the screen and the server always agree on the date.
 */
export function classicLoanDue(loan: LoanState, borrowerCircuits: number): string {
  switch (classicLoanStanding(loan, borrowerCircuits)) {
    case 'CURRENT': {
      if (loan.maturityCircuit === null) return 'no repayment date';
      const laps = loan.maturityCircuit - borrowerCircuits;
      return `principal due in ${laps} lap${laps === 1 ? '' : 's'}, at Start`;
    }
    case 'DUE':
      return 'principal due now — repay before your next Start';
    case 'OVERDUE':
      return 'overdue — repay before your next Start or it defaults';
    case 'DEFAULTED':
      return 'in default — repay it to borrow again';
    case 'CLOSED':
      return '';
  }
}

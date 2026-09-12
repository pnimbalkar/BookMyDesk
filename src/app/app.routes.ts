import { Routes } from '@angular/router';

export const routes: Routes = [
	{
		path: '',
		pathMatch: 'full',
		redirectTo: 'dashboard'
	},
	{
		path: 'dashboard/:deskNo',
		loadComponent: () =>
			import('./dashboard/dashboard').then((c) => c.Dashboard)
	},
	{
		path: 'dashboard',
		loadComponent: () =>
			import('./dashboard/dashboard').then((c) => c.Dashboard)
	},
	{
		path: 'login',
		loadComponent: () => import('./login/login').then((c) => c.Login)
	},
	{
		path: '**',
		redirectTo: 'dashboard'
	}
];

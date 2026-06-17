import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import { IconRow } from './IconRow';

describe('IconRow', () => {
	it('renders Chat, Cron, and Memory links', () => {
		render(
			<MemoryRouter>
				<IconRow />
			</MemoryRouter>,
		);
		expect(screen.getByLabelText('Chat')).toBeInTheDocument();
		expect(screen.getByLabelText('Cron')).toBeInTheDocument();
		expect(screen.getByLabelText('Memory')).toBeInTheDocument();
	});

	it('Memory link points to /memory', () => {
		render(
			<MemoryRouter>
				<IconRow />
			</MemoryRouter>,
		);
		expect(screen.getByLabelText('Memory')).toHaveAttribute('href', '/memory');
	});
});

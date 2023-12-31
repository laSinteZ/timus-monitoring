export interface Env {
	ATTEMPTS: KVNamespace;
	AUTHOR_ID: string;
	BOT_TOKEN: string;
	CHANNEL_ID: string;
}

const TIMUS_TIMEZONE = "GMT+0500";

function replaceRussianMonthWithEnglish(dateString: string): string {
  const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const englishMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  for (let i = 0; i < months.length; i++) {
    if (dateString.includes(months[i])) {
      return dateString.replace(months[i], englishMonths[i]);
    }
  }
  return dateString;
}

function formatDateToMoscowTime(date: Date) {
	const optionsTime = {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			timeZone: 'Europe/Moscow',
	} as const;
	
	const optionsDate = {
			day: '2-digit',
			month: 'long',
			year: 'numeric',
			timeZone: 'Europe/Moscow',
	} as const;
	
	const timeStr = date.toLocaleString('ru-RU', optionsTime);
	const dateStr = date.toLocaleString('ru-RU', optionsDate).replace(' г.', '');
	return `${timeStr}, ${dateStr}`;
}

type Attempt = Record<string, string> & { accepted?: boolean };
class TableHandler implements HTMLRewriterElementContentHandlers {
	currentRow: Attempt;
	rows: Attempt[];
	field: string | null;
	isInsideTr: boolean;
	prevText: string;

	static transformClassToField(className: string | null) {
		if (className?.includes("verdict")) return "verdict";
		return className
	}

	constructor() {
		this.currentRow = {};
		this.rows = [];
		this.field = "";
		this.isInsideTr = false;
		this.prevText = "";
	}

	element(element: Element) {
		if (element.tagName === 'td') {
			const className = element.getAttribute('class');
			this.field = TableHandler.transformClassToField(className);

			if (className === 'verdict_rj') this.currentRow.accepted = false;
			if (className === 'verdict_ac') this.currentRow.accepted = true;

			this.isInsideTr = true;
		}
		else if (element.tagName === 'tr' && this.isInsideTr) {
			// We were parsing a 'tr', but encountered another one. This means the last one ended.
			this.rows.push(this.currentRow);
			this.currentRow = {};
			this.isInsideTr = false;
		}
	}
	text(text: Text) {
		const trimmedText = text.text.trim().replace(/\n/g, '');
		// Avoid repeating values
		if (trimmedText === this.prevText) return;
		this.prevText = trimmedText;
		if (!this.field || !trimmedText) return;

		// Treat dates differently. TODO: proper dates with a correct timezone.
		if (this.field === "date" && !this.currentRow[this.field]) {
			this.currentRow[this.field] = (this.currentRow[this.field] || "") + trimmedText + " ";
			// Treat problems differently
		} else if (this.field === "problem" && this.currentRow[this.field]) {
			this.currentRow["problem_name"] = trimmedText.slice(2);
		}
		else {
			this.currentRow[this.field] = (this.currentRow[this.field] || "") + trimmedText;
		}
	}

	getRows() {
		// Don't forget about the last row.
		return [...this.rows, this.currentRow];
	}
}

function formatMessage(attempt: Attempt, env: Env): string {
	const linkProblem = `<a href="https://timus.online/problem.aspx?num=${attempt.problem}">${attempt.problem} – ${attempt.problem_name}</a>`;
	const linkCoder = `<a href="https://timus.online/status.aspx?author=${env.AUTHOR_ID}">${attempt.coder}</a>`;
	const formattedDate = formatDateToMoscowTime(new Date(replaceRussianMonthWithEnglish(attempt.date) + " " + TIMUS_TIMEZONE));

	return attempt.accepted ? `🎉 Ура! ${linkCoder} решил ${linkProblem} в ${formattedDate}` : `${linkCoder} попытался решить ${linkProblem} в ${formattedDate}, но случился ${attempt.verdict}`
}

async function sendTelegramMessage(botApiKey: string, chatId: string, message: string): Promise<void> {
	const url = 'https://api.telegram.org/bot' + botApiKey + '/sendMessage';
	const params = new URLSearchParams({
		chat_id: chatId,
		text: message,
		parse_mode: 'HTML'
	});

	try {
		const response = await fetch(url + '?' + params.toString(), {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
		});

		if (!response.ok) {
			// We assume server will return a JSON with 'description' field in case of error.
			const errorResponse: { description?: string } = await response.json();
			let message = `HTTP error! status: ${response.status}`;

			// Check if we got an error message back from the server
			if (errorResponse && errorResponse.description) {
				message += ` Message: ${errorResponse.description}`;
			}

			throw new Error(message);
		}
	} catch (error) {
		console.error('Error sending telegram message', error);
	}
}

export default {
	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
		const response = await fetch(`https://timus.online/status.aspx?author=${env.AUTHOR_ID}&count=10&locale=ru`);
		const tableHandler = new TableHandler();
		const rewriter = new HTMLRewriter()
			.on('tr.even, tr.odd', tableHandler)
			.on('tr.even td, tr.odd td', tableHandler)
			.transform(response);
		await rewriter.text();
		const wasSuccessful = response.ok ? 'success' : 'fail';
		if (!wasSuccessful) throw new Error("Can not fetch updates");

		let posted = 0;
		const attemptsChronologicalOrder = tableHandler.getRows().reverse();

		for (let i = 0; i < attemptsChronologicalOrder.length; i++) {
			const attempt = attemptsChronologicalOrder[i];
			const id = attempt['id'] || '';
			const isPresent = !!(await env.ATTEMPTS.get(id));

			if (!isPresent) {
				const message = formatMessage(attempt, env);
				await sendTelegramMessage(env.BOT_TOKEN, env.CHANNEL_ID, message);
				await env.ATTEMPTS.put(id, JSON.stringify(attempt));
				posted++;
			}
		}

		console.log(`Posted ${posted} messages`);
	},
};

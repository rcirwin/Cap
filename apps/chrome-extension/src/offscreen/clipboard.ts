// Offscreen documents can never take focus, so navigator.clipboard rejects
// there; Chrome's documented path is execCommand on a selected textarea with
// the CLIPBOARD offscreen reason and the clipboardWrite permission.
export const copyTextToClipboard = (text: string) => {
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	document.body.append(textarea);
	textarea.select();
	try {
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		textarea.remove();
	}
};

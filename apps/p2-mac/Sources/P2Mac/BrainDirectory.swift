// The brains the app knows: Radius's list (the same tabs, in the same order, as the Radius shell) merged with this
// Mac's server, which is reached directly whenever Radius lists it too (matched by the server ID in its data
// directory's radius.json). Signed in to Radius, the list is polled every 5 seconds, as the shell does; signed out,
// there is only this Mac's brain and windows show no tab bar.
//
// Cloud Pis (`cloudBrains`) get no tab yet: they have no forwarded origin of their own.
//
// For development without a Radius account, P2MAC_BRAINS names a JSON file in the list's shape; it counts as signed
// in.
import Foundation

@MainActor
final class BrainDirectory {
	static let changed = Notification.Name("P2MacBrainDirectoryChanged")

	private(set) var brains: [Brain] = []
	/// Windows show the tab bar: signed in to Radius, and the account has Pi.
	private(set) var showsTabs = false
	/// The list comes from P2MAC_BRAINS, not from Radius.
	let fixture: Bool
	var server: ServerController {
		didSet { rebuild() }
	}

	let radius: RadiusAccount
	private var list = RadiusBrainList(servers: [])
	private var enabled = true
	private var polling: Task<Void, Never>?

	init(server: ServerController, radius: RadiusAccount) {
		self.server = server
		self.radius = radius
		if let path = ProcessInfo.processInfo.environment["P2MAC_BRAINS"],
			let data = FileManager.default.contents(atPath: (path as NSString).expandingTildeInPath),
			let fixture = try? JSONDecoder().decode(RadiusBrainList.self, from: data)
		{
			list = fixture
			self.fixture = true
		} else {
			fixture = false
		}
		NotificationCenter.default.addObserver(forName: RadiusAccount.changed, object: radius, queue: .main) { [weak self] _ in
			MainActor.assumeIsolated { self?.accountChanged() }
		}
		rebuild()
		// radius.json may also appear, change or go behind the app's back (`radius:login`, the Pi): the poll looks every
		// time.
		polling = Task { [weak self] in
			while !Task.isCancelled {
				await self?.poll()
				try? await Task.sleep(for: .seconds(5))
			}
		}
	}

	func brain(_ id: String) -> Brain? { brains.first { $0.id == id } }

	/// This Mac's brain: the one windows open by default.
	var local: Brain? { brains.first(where: \.isDirect) }

	/// Signed in or out: the list again from scratch.
	private func accountChanged() {
		enabled = true
		if !fixture { list = RadiusBrainList(servers: []) }
		rebuild()
		Task { await poll() }
	}

	private func poll() async {
		guard !fixture else { return }
		guard radius.signedIn else {
			if !list.servers.isEmpty || showsTabs { accountChanged() }
			return
		}
		do {
			list = try JSONDecoder().decode(RadiusBrainList.self, from: try await radius.servers())
			enabled = true
		} catch RadiusAccount.Failure.notEnabled {
			enabled = false
		} catch {
			// A failed poll keeps the last list; a refused credential has signed the account out (accountChanged).
			return
		}
		rebuild()
	}

	/// Recomputes the tabs after the local server or Radius's list changed.
	func rebuild() {
		let config = server.config
		let localID = Self.radiusServerID(config.dataDir) ?? "local-\(config.port)"
		let localStatus: Brain.Status = server.phase == .running ? .online : .offline
		let direct = Brain.Route.direct(origin: config.origin, dataDir: config.dataDir)
		var tabs: [Brain] = []
		var matched = false
		// The shell's groupBrainsByOrganization: one group per organization in name order (a token sees one), its brains
		// by server ID.
		let organizations = Dictionary(grouping: list.servers.map(\.organization), by: \.id)
			.compactMap(\.value.first)
			.sorted { ($0.name, $0.id) < ($1.name, $1.id) }
		for organization in organizations {
			for entry in list.servers.filter({ $0.organization.id == organization.id }).sorted(by: { $0.serverId < $1.serverId }) {
				if entry.serverId == localID {
					matched = true
					tabs.append(Brain(id: entry.serverId, name: entry.label, organization: organization.brain, shared: false, status: localStatus, route: direct))
				} else {
					tabs.append(
						Brain(
							id: entry.serverId, name: entry.label, organization: organization.brain, shared: entry.shared ?? false,
							status: Brain.Status(rawValue: entry.status) ?? .unknown, route: .remote(organization: organization.id, server: entry.serverId)))
				}
			}
		}
		if !matched {
			let name = Self.localName(config.dataDir) ?? "This Mac"
			tabs.insert(Brain(id: localID, name: name, organization: nil, shared: false, status: localStatus, route: direct), at: 0)
		}
		let shows = fixture || (radius.signedIn && enabled)
		guard tabs != brains || shows != showsTabs else { return }
		brains = tabs
		showsTabs = shows
		NotificationCenter.default.post(name: Self.changed, object: self)
	}

	/// The server ID in a data directory's radius.json; only that field is read, never the credential.
	private static func radiusServerID(_ dataDir: URL) -> String? {
		guard let data = FileManager.default.contents(atPath: dataDir.appending(path: "radius.json").path),
			let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
		else { return nil }
		return object["serverId"] as? String
	}

	/// The brain's own name (p2's identity.json), as it reports it to Radius.
	private static func localName(_ dataDir: URL) -> String? {
		guard let data = FileManager.default.contents(atPath: dataDir.appending(path: "identity.json").path),
			let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
		else { return nil }
		return object["name"] as? String
	}
}

/// Radius's `/v1/pi/servers` (the shell's `/pi/api/brains`; radius `common/src/pi-brains.ts`): the list is `servers`
/// (`brains`, its old name, goes away); `cloudBrains` unused.
private struct RadiusBrainList: Decodable {
	let servers: [RadiusBrain]
}

private struct RadiusOrganization: Decodable {
	let id: String
	let name: String

	var brain: Brain.Organization { Brain.Organization(id: id, name: name) }
}

private struct RadiusBrain: Decodable {
	let serverId: String
	let name: String?
	let organization: RadiusOrganization
	let status: String
	let shared: Bool?

	/// The shell's `brainLabel` without the "Shared" prefix (Brain.label adds it): its name, else its ID's start.
	var label: String { name ?? String(serverId.prefix(8)) }
}
